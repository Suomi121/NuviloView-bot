import { checksum, denied } from './coordinator.mjs';
export const notificationId = (guildId, eventId) => checksum({ guildId, eventId }).slice(0,32);
export async function readApplicationNotifications({ store, userId, guildIds }) {
  const result = [], states = [];
  // Fresh Guild authorization is provided by the route on EVERY request.
  for (const guildId of guildIds) {
    const [alerts, receipts] = await Promise.all([
      store.read({ domain: 'alerts', guildId, actorId: userId }),
      store.read({ domain: 'notification-receipts', guildId, ownerId: userId, actorId: userId }),
    ]);
    states.push({ guildId, alerts: alerts.state, receipts: receipts.state, historyCoverage: alerts.data?.historyCoverage ?? 'unconfirmed' });
    const dismissed = new Set(receipts.data?.dismissed ?? []);
    for (const alert of alerts.data?.alerts ?? []) {
      const id = notificationId(guildId, alert.id);
      if (!dismissed.has(id)) result.push({ id, guildId, type: `alert:${alert.id}`, title: alert.title, body: alert.body, createdAt: new Date(alert.createdAt).toISOString(),
        token: { epoch: receipts.epoch, revision: receipts.revision, checksum: receipts.checksum, acknowledgeUnconfirmed: receipts.state === 'unconfirmed' } });
    }
  }
  return { notifications: result.sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,30), states };
}
export async function dismissApplicationNotification({ store, userId, guildId, id, token, requestId }) {
  if (!/^[a-f0-9]{32}$/.test(id)) denied('APP_RECEIPTS');
  const alerts = await store.read({ domain: 'alerts', guildId, actorId: userId });
  if (!(alerts.data?.alerts ?? []).some(a => notificationId(guildId,a.id) === id)) denied('APP_FORBIDDEN');
  const old = await store.read({ domain: 'notification-receipts', guildId, ownerId: userId, actorId: userId });
  if (old.state === 'unconfirmed' && token?.acknowledgeUnconfirmed !== true) denied('APP_CONFIRMATION_REQUIRED');
  return store.write({ domain: 'notification-receipts', guildId, ownerId: userId, actorId: userId, expectedEpoch: token?.epoch,
    expectedRevision: token?.revision, expectedChecksum: token?.checksum, acknowledgeUnconfirmed: token?.acknowledgeUnconfirmed,
    requestId, data: { dismissed: [...new Set([...(old.data?.dismissed ?? []), id])].slice(-500) } });
}
