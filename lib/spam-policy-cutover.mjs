import { DEFAULT_GUILD_SPAM_POLICY, parseGuildSpamPolicyRow } from './guild-spam-policy.mjs';

// Caller owns BEGIN/COMMIT. A cutover takes table locks, so concurrent legacy
// writes complete before the snapshot or run after the fence and are rejected.
export async function fenceSpamPolicyAuthority(client, { guildIds, writerId, epoch }) {
  if (!Array.isArray(guildIds) || !guildIds.length || new Set(guildIds).size !== guildIds.length ||
      guildIds.some(id => typeof id !== 'string' || !/^\d{16,22}$/.test(id)) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(writerId ?? '') || !/^[a-zA-Z0-9_-]{1,80}$/.test(epoch ?? '')) throw new Error('INVALID_CUTOVER_PLAN');
  const isolation = (await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows[0]?.isolation;
  if (isolation !== 'read committed') throw new Error('CUTOVER_REQUIRES_READ_COMMITTED');
  await client.query('LOCK TABLE guild_spam_policy, guild_security_v2_auto, guild_security_v2_enrollment, guild_spam_policy_authority IN SHARE ROW EXCLUSIVE MODE');
  const guards = (await client.query(`SELECT tgname, tgtype, tgenabled, tgrelid::regclass::text AS relation,
      p.proname AS function_name FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND tgrelid IN ('public.guild_spam_policy'::regclass, 'public.guild_security_v2_auto'::regclass)`)).rows;
  for (const [name, table, type, func] of [
    ['spam_policy_authority_fence', 'guild_spam_policy', 31, 'guard_spam_policy_authority'],
    ['spam_auto_authority_fence', 'guild_security_v2_auto', 23, 'guard_spam_auto_authority'],
    ['spam_policy_authority_truncate_fence', 'guild_spam_policy', 34, 'guard_spam_policy_truncate'],
  ]) {
    if (!guards.some(g => g.tgname === name && g.relation === table && Number(g.tgtype) === type &&
      ['O', 'A'].includes(g.tgenabled) && g.function_name === func)) throw new Error('CUTOVER_FENCE_GUARD_MISSING');
  }
  const snapshots = [];
  for (const guildId of guildIds) {
    const auto = (await client.query('SELECT e.migration_state, e.detection_policy_seen, a.enabled FROM guild_security_v2_enrollment e JOIN guild_security_v2_auto a USING (guild_id) WHERE e.guild_id=$1', [guildId])).rows[0];
    if (auto?.migration_state !== 'complete' || auto?.enabled !== false) throw new Error('CUTOVER_REQUIRES_VERIFIED_AUTO_OFF');
    const existing = (await client.query('SELECT * FROM guild_spam_policy_authority WHERE guild_id=$1', [guildId])).rows[0];
    if (existing) {
      if (existing.writer_id !== writerId || existing.epoch !== epoch) throw new Error('CUTOVER_AUTHORITY_CONFLICT');
      snapshots.push(existing.snapshot);
      continue;
    }
    const row = (await client.query('SELECT * FROM guild_spam_policy WHERE guild_id=$1', [guildId])).rows[0];
    const policy = row ? parseGuildSpamPolicyRow(row) : DEFAULT_GUILD_SPAM_POLICY;
    if (!policy) throw new Error('CUTOVER_INVALID_POLICY');
    // A previously present but missing policy must not silently become defaults.
    if (!row && (auto.detection_policy_seen || (await client.query('SELECT 1 FROM guild_spam_policy_audit WHERE guild_id=$1 LIMIT 1', [guildId])).rowCount)) throw new Error('CUTOVER_POLICY_MISSING');
    const snapshot = { guildId, writerId, epoch, policy, autoTimeout: false, fenced: true };
    await client.query('INSERT INTO guild_spam_policy_authority (guild_id, writer_id, epoch, snapshot) VALUES ($1,$2,$3,$4::jsonb)', [guildId, writerId, epoch, JSON.stringify(snapshot)]);
    snapshots.push(snapshot);
  }
  return snapshots;
}
