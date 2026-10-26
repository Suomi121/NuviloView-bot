import { checksum } from './coordinator.mjs';
// Global abuse protection uses the SAME cloud quorum on every Web instance.
// No process-memory/SQLite fallback may turn a failed mutation check into allow.
export async function quorumRateLimited({ coordinator, controlId, key, limit, windowMs, at = Date.now() }) {
  if (!/^\d{16,22}$/.test(controlId ?? '') || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1000) return true;
  const bucket = Math.floor(at / windowMs), scope = coordinator.scoped(`rate-${checksum({ key, bucket }).slice(0,32)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    let old;
    try { old = await scope.read(controlId); } catch (e) { if (e.code !== 'MDB_NOT_ENROLLED') return true; }
    const count = old?.value.data.count ?? 0;
    if (!Number.isInteger(count) || count >= limit) return true;
    try {
      await scope.update({ guildId: controlId, actorId: 'rate-limiter', requestId: crypto.randomUUID().replaceAll('-',''), expectedRevision: old?.value.revision ?? 0,
        expectedChecksum: old?.checksum ?? 'GENESIS', action: 'rate:consume', data: { count: count + 1, bucket } });
      return false;
    } catch (e) { if (e.code !== 'MDB_REVISION_CONFLICT') return true; }
  }
  return true;
}
