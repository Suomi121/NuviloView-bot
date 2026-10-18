import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { SET_TIMEOUT_LOG_SQL, readTimeoutLogChannel } from '../../lib/security-log-settings.mjs';
export async function verifyTimeoutLogSettings(client, url) {
  const query = (q,p) => client.query(q,p);
  await query(readFileSync(new URL('../../scripts/migrations/20261019-security-timeout-log.sql', import.meta.url), 'utf8'));
  const a='100000000000000001', b='100000000000000002', channel='400000000000000001';
  assert.equal(await readTimeoutLogChannel(query,a), null);
  await query(SET_TIMEOUT_LOG_SQL,[a,channel,'owner']);
  assert.equal(await readTimeoutLogChannel(query,a), channel);
  assert.equal(await readTimeoutLogChannel(query,b), null);
  await query(SET_TIMEOUT_LOG_SQL,[a,null,'owner']);
  assert.equal(await readTimeoutLogChannel(query,a), null);
  await query('BEGIN');
  await query("ALTER TABLE guild_security_log_audit ADD CONSTRAINT isolated_reject CHECK (actor_id <> 'reject')");
  await assert.rejects(query(SET_TIMEOUT_LOG_SQL,[a,channel,'reject']));
  await query('ROLLBACK');
  assert.equal(await readTimeoutLogChannel(query,a), null);
  assert.equal((await query('SELECT count(*)::int n FROM guild_security_log_audit')).rows[0].n,2);
  const pool=new pg.Pool({connectionString:url,max:4});
  try { await Promise.all(Array.from({length:10},(_,i)=>pool.query(SET_TIMEOUT_LOG_SQL,[a,i%2 ? channel:null,'owner']))); }
  finally { await pool.end(); }
  const audits=(await query('SELECT * FROM guild_security_log_audit WHERE guild_id=$1 ORDER BY revision',[a])).rows;
  assert.equal(audits.length,12); assert.equal(new Set(audits.map(r=>r.revision)).size,12);
  assert.equal(await readTimeoutLogChannel(query,a),audits.at(-1).channel_id);
}
