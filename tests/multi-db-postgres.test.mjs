import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';
import { createSqlAcceptor, ACCEPTOR_SCHEMA } from '../lib/multi-db/acceptor.mjs';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { createSecurityService, initialSecuritySnapshot } from '../lib/multi-db/security-service.mjs';
import { isolatedTursoHttp } from './helpers/isolated-turso-http.mjs';

test('real PostgreSQL + Turso HTTP SDK: CAS, write failure, recovery and old SQL writer fences', { skip: !process.env.TEST_COORDINATOR_DATABASE_URL }, async t => {
  const url = new URL(process.env.TEST_COORDINATOR_DATABASE_URL);
  assert.equal(process.env.TEST_COORDINATOR_ISOLATED, '1');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/nuviloview_quorum_test');
  const a = new Client({ connectionString: url.href }), b = new Client({ connectionString: url.href });
  await a.connect(); await b.connect(); t.after(async () => { await a.end(); await b.end(); });
  await a.query('CREATE SCHEMA neon; CREATE SCHEMA supabase');
  await a.query('SET search_path=neon'); await b.query('SET search_path=supabase');
  await a.query(ACCEPTOR_SCHEMA); await b.query(ACCEPTOR_SCHEMA);
  const turso = await isolatedTursoHttp(t); turso.db.exec(ACCEPTOR_SCHEMA);
  const providers = [createSqlAcceptor({ id: 'neon', dialect: 'postgres', execute: (q, p) => a.query(q, p) }),
    createSqlAcceptor({ id: 'supabase', dialect: 'postgres', execute: (q, p) => b.query(q, p) }),
    createSqlAcceptor({ id: 'turso', dialect: 'sqlite', execute: (q, args) => turso.client.execute({ sql: q, args }) })];
  const coordinator = createCoordinator({ providers, epoch: 'isolated-v1' });
  await a.query("INSERT INTO mdb_membership VALUES(1,$1,'neon')", [coordinator.membership]);
  await b.query("INSERT INTO mdb_membership VALUES(1,$1,'supabase')", [coordinator.membership]);
  turso.db.prepare("INSERT INTO mdb_membership VALUES(1,?,'turso')").run(coordinator.membership);
  const security = createSecurityService(coordinator), guildId = '100000000000000001';
  let state = await security.importFenced({ guildId, actorId: 'fixture', requestId: 'import', snapshot: initialSecuritySnapshot(), verifyFence: async () => true });
  await a.query('SET default_transaction_read_only=on');
  state = await security.change({ guildId, actorId: 'fixture', requestId: 'strength', expectedRevision: state.value.revision,
    expectedChecksum: state.checksum, operation: 'level', value: 79, authorize: async () => true });
  assert.equal(state.value.data.policy.strength, 79);
  await a.query('SET default_transaction_read_only=off');
  await security.read(guildId);
  const repaired = await a.query('SELECT checksum FROM mdb_acceptor WHERE guild_id=$1 AND slot=2', [guildId]);
  assert.equal(repaired.rows[0].checksum, state.checksum);
  turso.setOffline(true);
  state = await security.change({ guildId, actorId: 'fixture', requestId: 'auto', expectedRevision: state.value.revision,
    expectedChecksum: state.checksum, operation: 'auto:on', value: null, authorize: async () => true });
  assert.equal(state.value.data.autoTimeout, true);
  turso.setOffline(false); await security.read(guildId);
  assert.equal(turso.db.prepare('SELECT checksum FROM mdb_acceptor WHERE slot=3').get().checksum, state.checksum);

  // Full legacy fence migration, real triggers. No existing production schemas.
  await a.query('CREATE SCHEMA legacy; SET search_path=legacy');
  for (const name of ['20260930-guild-spam-policy','20261001-guild-spam-protection-controls','20261017-security-v2-consent','20261017-security-operator-roles','20261019-security-timeout-log','20261025-security-quorum']) {
    await a.query(fs.readFileSync(new URL(`../scripts/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  await a.query('INSERT INTO guild_security_quorum_fence(guild_id,epoch,snapshot_checksum) VALUES($1,$2,$3)', [guildId, 'isolated-v1', state.checksum]);
  for (const sql of [
    'INSERT INTO guild_spam_policy(guild_id) VALUES($1)',
    'INSERT INTO guild_security_v2_auto(guild_id,enabled) VALUES($1,true)',
    'INSERT INTO guild_security_operator(guild_id,role_ids) VALUES($1,ARRAY[]::text[])',
    'INSERT INTO guild_security_log(guild_id,channel_id) VALUES($1,NULL)',
  ]) await assert.rejects(a.query(sql, [guildId]), e => e.code === '55000');
  for (const table of ['guild_spam_policy','guild_security_v2_auto','guild_security_v2_enrollment','guild_security_operator','guild_security_log','security_v2_control']) {
    await assert.rejects(a.query(`TRUNCATE ${table} CASCADE`), e => e.code === '55000');
  }
});

test('real Turso HTTP SDK adapter: promise fencing and SQL parameter preservation', async t => {
  const turso = await isolatedTursoHttp(t); turso.db.exec(ACCEPTOR_SCHEMA);
  const membership = 'isolated'; turso.db.prepare("INSERT INTO mdb_membership VALUES(1,?,'turso')").run(membership);
  const adapter = createSqlAcceptor({ id: 'turso', dialect: 'sqlite', execute: (sql, args) => turso.client.execute({ sql, args }) });
  const ballot = '0000000000000001:' + 'a'.repeat(32);
  const result = await adapter.prepare(membership, '100000000000000001', 1, ballot);
  assert.equal(result.promised, ballot);
  assert.equal(await adapter.accept(membership, '100000000000000001', 1, ballot, { quote: "'); DROP TABLE x;--" }, 'test'), true);
  assert.equal(turso.db.prepare('SELECT count(*) n FROM mdb_acceptor').get().n, 1);
  assert.equal(await adapter.accept(membership, '100000000000000001', 1, ballot, { quote: 'different' }, 'other'), false);
});
