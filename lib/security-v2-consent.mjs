// Shared by Discord and Web. No credentials, implicit enable, DELETE or cache.
export const SECURITY_V2_TIMEOUT_MS = 24 * 60 * 60_000;
const idPattern = /^\d{16,22}$/;
const rows = result => Array.isArray(result) ? result : result?.rows ?? [];
function id(value) {
  if (!idPattern.test(String(value))) throw new Error('SECURITY_V2_INVALID_ID');
  return String(value);
}
export const READ_SECURITY_V2_SQL = `
 SELECT e.migration_state, a.enabled, a.revision, c.emergency_stop
 FROM (SELECT $1::text AS guild_id) target
 LEFT JOIN guild_security_v2_enrollment e USING (guild_id)
 LEFT JOIN guild_security_v2_auto a USING (guild_id)
 LEFT JOIN security_v2_control c ON c.singleton = true`;
export function securityV2State(row) {
  const migrationState = row?.migration_state ?? 'unmigrated';
  const autoTimeout = migrationState === 'complete' && row?.enabled === true;
  const emergencyStop = row?.emergency_stop !== false;
  return { migrationState, autoTimeout, emergencyStop,
    effective: autoTimeout && !emergencyStop, revision: String(row?.revision ?? '0') };
}
export async function readSecurityV2(query, guildId) {
  try { return securityV2State(rows(await query(READ_SECURITY_V2_SQL, [id(guildId)]))[0]); }
  catch { return { ...securityV2State(null), migrationState: 'unavailable' }; }
}
// Atomic enrollment + default OFF + completion. Re-entry/restart never resets
// an explicit choice. Failed transactions leave no partial completion.
export const ENROLL_SECURITY_V2_SQL = `
 WITH enrolled AS (
   INSERT INTO guild_security_v2_enrollment (guild_id, migration_state, completed_at)
   VALUES ($1::text, 'complete', now())
   ON CONFLICT (guild_id) DO UPDATE SET migration_state = 'complete', completed_at = COALESCE(guild_security_v2_enrollment.completed_at, now())
   RETURNING guild_id
 )
 INSERT INTO guild_security_v2_auto (guild_id, enabled, revision)
 SELECT guild_id, false, COALESCE((SELECT max(revision) FROM guild_security_v2_audit WHERE guild_id = $1::text), 0) + 1 FROM enrolled
 ON CONFLICT (guild_id) DO NOTHING`;
export async function enrollSecurityV2(query, guildId) {
  await query(ENROLL_SECURITY_V2_SQL, [id(guildId)]);
}
export const SET_SECURITY_V2_SQL = `
 WITH saved AS (
   INSERT INTO guild_security_v2_auto (guild_id, enabled, updated_by)
   SELECT guild_id, $2::boolean, $3::text FROM guild_security_v2_enrollment
   WHERE guild_id = $1::text AND migration_state = 'complete'
   ON CONFLICT (guild_id) DO UPDATE SET enabled = EXCLUDED.enabled,
     revision = guild_security_v2_auto.revision + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
   RETURNING guild_id, enabled, revision
 ), audited AS (
   INSERT INTO guild_security_v2_audit (guild_id, enabled, revision, actor_id)
   SELECT guild_id, enabled, revision, $3::text FROM saved RETURNING id
 ) SELECT saved.enabled, saved.revision FROM saved CROSS JOIN audited`;
// Caller must authenticate/authorize the Guild first. Only explicit on/off accepted.
export async function setSecurityV2Auto(query, guildId, actorId, operation) {
  if (!['on', 'off'].includes(operation)) throw new Error('SECURITY_V2_INVALID_OPERATION');
  if (typeof actorId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(actorId)) throw new Error('SECURITY_V2_INVALID_ACTOR');
  const result = rows(await query(SET_SECURITY_V2_SQL, [id(guildId), operation === 'on', actorId]));
  if (result.length !== 1) throw new Error('SECURITY_V2_NOT_ENROLLED');
  return { autoTimeout: result[0].enabled, revision: String(result[0].revision) };
}
export async function mayAutomaticallyTimeout(query, guildId, { emergencyStop = true } = {}) {
  if (emergencyStop) return false;
  return (await readSecurityV2(query, guildId)).effective;
}
