import { checksum, denied } from './coordinator.mjs';
export async function appendApplicationAlert({ store, guildId, actorId, type, title, body, cooldownMinutes = 30, now = Date.now(), proveOwner }) {
  if (typeof proveOwner !== 'function' || await proveOwner() !== true) denied('APP_PUBLISHER_FENCED');
  const old = await store.read({ domain: 'alerts', guildId, actorId });
  const alerts = old.data?.alerts ?? [];
  if (alerts.some(a => a.type === type && now - a.createdAt < cooldownMinutes * 60000)) return { duplicate: true };
  const alert = { id: checksum({ guildId, type, bucket: Math.floor(now / Math.max(60000,cooldownMinutes * 60000)) }).slice(0,32), type, title, body, createdAt: now };
  if (await proveOwner() !== true) denied('APP_PUBLISHER_FENCED');
  return store.write({ domain: 'alerts', guildId, actorId, expectedEpoch: old.epoch, expectedRevision: old.revision, expectedChecksum: old.checksum,
    acknowledgeUnconfirmed: true, requestId: `alert:${alert.id}`, data: { historyCoverage: old.data?.historyCoverage ?? 'since_epoch', alerts: [...alerts.filter(a => now - a.createdAt <= 7 * 86400000),alert].slice(-200) } });
}
