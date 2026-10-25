import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { ACCEPTOR_SCHEMA, createSqlAcceptor } from '../lib/multi-db/acceptor.mjs';

const guild = '100000000000000001';
const other = '100000000000000002';
const epoch = 'isolated-test-v1';
export function fixture(t) {
  const dbs = [], faults = {}, counters = {};
  const providers = ['neon', 'supabase', 'turso'].map(id => {
    const db = new DatabaseSync(':memory:'); db.exec(ACCEPTOR_SCHEMA); dbs.push(db);
    const adapter = createSqlAcceptor({ id, dialect: 'sqlite', execute: async (sql, args) => {
      if (faults[id] === 'offline' || (faults[id] === 'readOnly' && !sql.startsWith('SELECT'))) throw new Error('PRIVATE_URL_TOKEN');
      counters[id] = (counters[id] ?? 0) + 1;
      return db.prepare(sql).all(...args);
    } });
    return adapter;
  });
  const c = createCoordinator({ providers, epoch });
  for (const [i, db] of dbs.entries()) db.prepare('INSERT INTO mdb_membership VALUES(1,?,?)').run(c.membership, providers[i].id);
  t.after(() => dbs.forEach(d => d.close()));
  return { c, providers, dbs, faults, counters };
}
const write = (c, revision, hash, requestId, data = { autoTimeout: false, strength: 50 }, g = guild) => c.update({
  guildId: g, expectedRevision: revision, expectedChecksum: hash, actorId: 'fixture', action: 'test', requestId, data });

test('real SQLite SQL acceptors: majority CAS, idempotency, restart, Guild separation', async t => {
  const { c, providers } = fixture(t);
  const first = await write(c, 0, 'GENESIS', 'seed');
  const next = await write(c, 1, first.checksum, 'change', { autoTimeout: false, strength: 90 });
  assert.equal(next.value.revision, 2);
  assert.deepEqual((await write(c, 1, first.checksum, 'change', { autoTimeout: false, strength: 90 })).value, next.value);
  await assert.rejects(write(c, 1, first.checksum, 'conflict'), { code: 'MDB_REVISION_CONFLICT' });
  await assert.rejects(write(c, 1, first.checksum, 'change'), { code: 'MDB_IDEMPOTENCY_CONFLICT' });
  const restarted = createCoordinator({ providers, epoch });
  assert.equal((await restarted.read(guild)).value.data.strength, 90);
  await assert.rejects(restarted.read(other), { code: 'MDB_NOT_ENROLLED' });
  await write(c, 0, 'GENESIS', 'seed', { strength: 1 }, other);
  assert.equal((await c.read(guild)).value.data.strength, 90);
});

for (const failed of ['neon', 'supabase', 'turso']) test(`${failed} offline: two remaining stores keep agreed writes; repair on recovery`, async t => {
  const { c, faults, dbs } = fixture(t);
  const first = await write(c, 0, 'GENESIS', 'seed');
  faults[failed] = 'offline';
  const next = await write(c, 1, first.checksum, 'change', { strength: 87 });
  assert.equal((await c.read(guild)).checksum, next.checksum);
  faults[failed] = null;
  await c.read(guild);
  for (const db of dbs) assert.equal(db.prepare('SELECT checksum FROM mdb_acceptor WHERE guild_id=? AND slot=2').get(guild).checksum, next.checksum);
});

test('multiple outages / read-only stores refuse writes, never local promotion', async t => {
  const { c, faults } = fixture(t);
  faults.neon = 'offline'; faults.supabase = 'offline';
  await assert.rejects(write(c, 0, 'GENESIS', 'seed'), { code: 'MDB_NO_READ_QUORUM' });
  faults.neon = 'readOnly'; faults.supabase = 'readOnly';
  await assert.rejects(write(c, 0, 'GENESIS', 'seed'), { code: 'MDB_NO_WRITE_QUORUM' });
  assert.doesNotMatch(JSON.stringify(c.diagnostics()), /PRIVATE_URL_TOKEN/);
});

test('concurrent Web/Bot writers: one CAS winner, losing writer cannot roll back', async t => {
  const { c, providers } = fixture(t);
  const first = await write(c, 0, 'GENESIS', 'seed');
  const web = createCoordinator({ providers, epoch });
  const results = await Promise.allSettled([write(c, 1, first.checksum, 'bot', { strength: 12 }), write(web, 1, first.checksum, 'web', { strength: 88 })]);
  assert.ok(results.filter(v => v.status === 'fulfilled').length <= 1);
  const current = await c.read(guild);
  assert.equal(current.value.revision, 2);
  assert.ok([12, 88].includes(current.value.data.strength));
  await assert.rejects(write(web, 1, first.checksum, 'stale'), { code: 'MDB_REVISION_CONFLICT' });
});

test('old writer fenced by durable promises; same-ballot conflicting accept rejected', async t => {
  const { c, providers } = fixture(t);
  const a = '0000000000000001:' + 'a'.repeat(32), b = '0000000000000002:' + 'b'.repeat(32);
  for (const p of providers) await p.prepare(c.membership, guild, 1, a);
  for (const p of providers.slice(0, 2)) await p.prepare(c.membership, guild, 1, b);
  const accepted = await Promise.all(providers.map(p => p.accept(c.membership, guild, 1, a, { x: 1 }, 'a')));
  assert.equal(accepted.filter(Boolean).length, 1);
});

test('checksum corruption and membership mismatch cannot become healthy authority', async t => {
  const { c, dbs } = fixture(t);
  await write(c, 0, 'GENESIS', 'seed');
  for (const db of dbs) db.prepare("UPDATE mdb_acceptor SET checksum='corrupt' WHERE slot=1").run();
  await assert.rejects(c.read(guild), { code: 'MDB_CHECKSUM_CONFLICT' });
  for (const db of dbs) db.prepare("UPDATE mdb_membership SET membership='old' WHERE singleton=1").run();
  await assert.rejects(c.read(guild), { code: 'MDB_NO_READ_QUORUM' });
});

test('uncertain write outcome recovers accepted value before new revision', async t => {
  const { c, providers } = fixture(t);
  const first = await write(c, 0, 'GENESIS', 'seed');
  const wrappers = providers.map(p => ({ ...p, async accept(...args) {
    const result = await p.accept(...args);
    if (args[2] === 2) throw new Error('LOST_REPLY_AFTER_DURABLE_ACCEPT');
    return result;
  } }));
  const broken = createCoordinator({ providers: wrappers, epoch });
  await assert.rejects(write(broken, 1, first.checksum, 'uncertain', { strength: 33 }), { code: 'MDB_OUTCOME_UNKNOWN' });
  const after = await c.read(guild);
  assert.equal(after.value.revision, 2);
  assert.equal(after.value.data.strength, 33);
  assert.equal((await write(c, 1, first.checksum, 'uncertain', { strength: 33 })).checksum, after.checksum);
});

for (const fault of ['AUTH_FAILURE', 'QUOTA_EXCEEDED', 'READ_ONLY', 'HIGH_LATENCY']) test(`Neon ${fault} never causes unproved authority promotion`, async t => {
  const f = fixture(t);
  const providers = f.providers.map(p => p.id === 'neon' ? { ...p,
    load: () => fault === 'HIGH_LATENCY' ? new Promise(() => {}) : Promise.reject(new Error(fault)),
    prepare: () => Promise.reject(new Error(fault)), accept: () => Promise.reject(new Error(fault)),
  } : p);
  const c = createCoordinator({ providers, epoch, timeoutMs: 20 });
  const state = await write(c, 0, 'GENESIS', 'seed');
  assert.equal((await c.read(guild)).checksum, state.checksum);
  assert.equal(c.diagnostics().authority, 'cloud-quorum');
  assert.equal(c.diagnostics().providers.neon.write, 'UNAVAILABLE');
});
