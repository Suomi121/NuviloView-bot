import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { enrollSecurityV2, setSecurityV2Auto, readSecurityV2, mayAutomaticallyTimeout } from '../../lib/security-v2-consent.mjs';
export async function verifySecurityV2(client, connectionString) {
  const query = (q, p) => client.query(q, p);
  const a = '100000000000000001', b = '100000000000000002', c = '100000000000000009';
  const sql = readFileSync(new URL('../../scripts/migrations/20261017-security-v2-consent.sql', import.meta.url), 'utf8');
  const before = (await query('SELECT * FROM guild_spam_policy ORDER BY guild_id')).rows;
  await query('BEGIN'); await query(sql); await query('ROLLBACK');
  assert.equal((await query("SELECT to_regclass('public.guild_security_v2_auto') t")).rows[0].t, null);
  await query('BEGIN'); await query(sql); await query('COMMIT');
  assert.deepEqual((await query('SELECT * FROM guild_spam_policy ORDER BY guild_id')).rows, before);
  assert.equal((await readSecurityV2(query, a)).migrationState, 'pending');
  assert.equal((await readSecurityV2(query, c)).migrationState, 'unmigrated');
  for (const guild of [a,b,c]) {
    await enrollSecurityV2(query, guild);
    assert.equal((await readSecurityV2(query, guild)).autoTimeout, false);
  }
  await setSecurityV2Auto(query, a, 'discord:100000000000000003', 'on');
  assert.equal(await mayAutomaticallyTimeout(query, a, { emergencyStop: false }), false);
  // Isolated DB only: simulate an approved release removing the global stop.
  await query('UPDATE security_v2_control SET emergency_stop=false');
  assert.equal(await mayAutomaticallyTimeout(query, a, { emergencyStop: false }), true);
  assert.equal(await mayAutomaticallyTimeout(query, b, { emergencyStop: false }), false);
  await setSecurityV2Auto(query, a, 'web:test-user', 'off');
  await enrollSecurityV2(query, a); // restart must preserve OFF
  assert.equal((await readSecurityV2(query, a)).autoTimeout, false);
  const pool = new pg.Pool({ connectionString, max: 10 });
  try {
    await Promise.all(Array.from({length: 10}, (_, i) => setSecurityV2Auto((q,p) => pool.query(q,p), a, 'test', i % 2 ? 'off' : 'on')));
  } finally { await pool.end(); }
  await setSecurityV2Auto(query, a, 'test', 'off');
  const audits = (await query('SELECT * FROM guild_security_v2_audit WHERE guild_id=$1 ORDER BY revision', [a])).rows;
  assert.equal(audits.length, 13); assert.equal(new Set(audits.map(r => r.revision)).size, 13);
  assert.equal(audits.at(-1).enabled, false);
  await query('DELETE FROM guild_security_v2_auto WHERE guild_id=$1', [a]);
  assert.equal((await readSecurityV2(query, a)).migrationState, 'complete');
  assert.equal(await mayAutomaticallyTimeout(query, a, { emergencyStop: false }), false);
  await enrollSecurityV2(query, a); assert.equal((await readSecurityV2(query, a)).autoTimeout, false);
  // Force an audit failure: consent must roll back, not partially enable.
  await query('BEGIN');
  await query("ALTER TABLE guild_security_v2_audit ADD CONSTRAINT isolated_reject CHECK (actor_id <> 'reject')");
  await assert.rejects(setSecurityV2Auto(query, b, 'reject', 'on'));
  await query('ROLLBACK');
  assert.equal((await readSecurityV2(query, b)).autoTimeout, false);
  assert.deepEqual((await query('SELECT * FROM guild_spam_policy ORDER BY guild_id')).rows, before);
}
