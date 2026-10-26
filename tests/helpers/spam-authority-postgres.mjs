import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fenceSpamPolicyAuthority } from '../../lib/spam-policy-cutover.mjs';
import { enrollSecurityV2, setSecurityV2Auto } from '../../lib/security-v2-consent.mjs';
import { createLocalStorage } from '../../lib/storage/index.mjs';
import { createSpamPolicyAuthority } from '../../lib/spam-policy-authority.mjs';
import { createPostgresProviderAdapter } from '../../lib/sync/providers/postgres.mjs';
import pg from 'pg';

export async function verifySpamAuthority(client, connectionString) {
  await client.query(readFileSync(new URL('../../scripts/migrations/20261022-spam-policy-authority.sql', import.meta.url), 'utf8'));
  const guildIds = Array.from({ length: 17 }, (_, n) => String(200000000000000001n + BigInt(n)));
  const query = (q, p) => client.query(q, p);
  for (const guildId of guildIds) await enrollSecurityV2(query, guildId);
  await query('INSERT INTO guild_spam_policy (guild_id,updated_by) VALUES ($1,$2)', [guildIds[0], 'fixture']);
  const plan = { guildIds, writerId: 'isolated-writer', epoch: 'isolated-epoch' };
  const before = (await query('SELECT * FROM guild_security_v2_auto ORDER BY guild_id')).rows;
  await query('BEGIN');
  await query('ALTER TABLE guild_spam_policy DISABLE TRIGGER spam_policy_authority_fence');
  await assert.rejects(fenceSpamPolicyAuthority(client, plan), /FENCE_GUARD_MISSING/);
  await query('ROLLBACK');
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await assert.rejects(query('UPDATE guild_spam_policy SET strength=1 WHERE guild_id=$1', [guildIds[0]]), e => e.code === '55000');
  await query('ROLLBACK');
  await query('BEGIN');
  const snapshots = await fenceSpamPolicyAuthority(client, plan);
  // A legacy write already waiting on the cutover lock must see the committed fence.
  const concurrent = new pg.Client({ connectionString });
  await concurrent.connect();
  let pending;
  try {
    await concurrent.query("SET statement_timeout = '5s'");
    pending = concurrent.query('UPDATE guild_spam_policy SET strength=1 WHERE guild_id=$1', [guildIds[0]])
      .then(() => ({ code: 'unexpected-success' }), error => ({ code: error.code }));
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      blocked = (await query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [concurrent.processID])).rows[0].blocked;
      if (blocked) break;
    }
    assert.equal(blocked, true);
    await query('COMMIT');
    assert.equal((await pending).code, '55000');
  } finally { await query('ROLLBACK'); await pending; await concurrent.end(); }
  assert.equal(snapshots.length, 17);
  assert.deepEqual((await query('SELECT * FROM guild_security_v2_auto ORDER BY guild_id')).rows, before);
  const storage = createLocalStorage({ databasePath: ':memory:' });
  try {
    const authority = createSpamPolicyAuthority({ storage, writerId: plan.writerId, enabled: true });
    for (const snapshot of snapshots) authority.importFencedSnapshot(snapshot);
    assert.equal(authority.update({ guildId: guildIds[0], actorId: '100000000000000003', requestId: '100000000000000009', operation: 'level', value: 82, expectedRevision: 1 }).policy.strength, 82);
    await query(readFileSync(new URL('../../docs/sql/multi-db-supabase-v1.sql', import.meta.url), 'utf8'));
    const event = storage.outbox.getByEventId(`spam-policy-command:${guildIds[0]}:100000000000000009`);
    for (const id of ['supabase', 'neon']) {
      const adapter = createPostgresProviderAdapter({ id, enabled: true, required: id === 'supabase', execute: query });
      assert.deepEqual((await adapter.pushEvents([event])).succeededEventIds, [event.eventId]);
      assert.deepEqual((await adapter.pushEvents([event])).succeededEventIds, [event.eventId]);
    }
    await assert.rejects(query('INSERT INTO guild_spam_policy (guild_id) VALUES ($1)', [guildIds[0]]), e => e.code === '55000');
    await assert.rejects(query('UPDATE guild_spam_policy SET strength=1 WHERE guild_id=$1', [guildIds[0]]), e => e.code === '55000');
    await assert.rejects(query('DELETE FROM guild_spam_policy WHERE guild_id=$1', [guildIds[0]]), e => e.code === '55000');
    await assert.rejects(query('UPDATE guild_spam_policy SET guild_id=$2 WHERE guild_id=$1', [guildIds[0], '900000000000000001']), e => e.code === '55000');
    await assert.rejects(query('TRUNCATE guild_spam_policy'), e => e.code === '55000');
    await assert.rejects(setSecurityV2Auto(query, guildIds[0], 'isolated', 'on'), e => e.code === '55000');
    assert.deepEqual((await query('SELECT * FROM guild_security_v2_auto ORDER BY guild_id')).rows, before);
    await query('BEGIN');
    const retry = await fenceSpamPolicyAuthority(client, plan);
    await query('COMMIT');
    for (const snapshot of retry) authority.importFencedSnapshot(snapshot);
    assert.equal(authority.read(guildIds[0]).policy.strength, 82);
    await query('BEGIN');
    await assert.rejects(fenceSpamPolicyAuthority(client, { ...plan, writerId: 'wrong-writer' }), /AUTHORITY_CONFLICT/);
    await query('ROLLBACK');
  } finally { storage.close(); }
  const extra = '300000000000000001';
  await enrollSecurityV2(query, extra);
  await setSecurityV2Auto(query, extra, 'isolated', 'on');
  await query('BEGIN');
  await assert.rejects(fenceSpamPolicyAuthority(client, { ...plan, guildIds: [extra] }), /VERIFIED_AUTO_OFF/);
  await query('ROLLBACK');
  assert.equal((await query('SELECT 1 FROM guild_spam_policy_authority WHERE guild_id=$1', [extra])).rowCount, 0);
}
