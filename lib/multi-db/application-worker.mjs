import { createApplicationStore } from './application-store.mjs';
import { publishApplicationProjection } from './application-projection.mjs';
import { checksum } from './coordinator.mjs';

// Durable SQLite snapshots are the retry source. Never delete an Outbox/DLQ
// record or advance a cloud delivery receipt after a failed quorum publication.
export function createApplicationPublisher({ runtime, storage, applicationId, publisherId, sourceEpoch, now = Date.now }) {
  let cursor = 0, lastAttempt = null, state = 'NOT_RUN', lastError = null, lastSuccess = null;
  const store = createApplicationStore({ ...runtime, authorize: async ({ operation, domain }) => operation === 'read' || ['analytics','runtime'].includes(domain) });
  return {
    async processOnce() {
      if (lastAttempt !== null && now() - lastAttempt < 30000) return;
      lastAttempt = now();
      try {
        const guilds = await runtime.coordinator.listGuilds();
        const guildId = guilds[cursor++ % Math.max(1,guilds.length)];
        if (!guildId) return;
        const snapshots = storage.snapshots.listGuildSnapshots(guildId);
        const sourceSequence = snapshots.reduce((sum,s) => sum + s.snapshotVersion, 0);
        if (snapshots.length) await publishApplicationProjection({ store, coordinator: runtime.coordinator, guildId, actorId: publisherId,
          publisherId, applicationId, sourceEpoch, sourceSequence, snapshots });
        const owner = await runtime.coordinator.scoped('application-publisher').read(applicationId);
        if (owner.value.data.publisherId !== publisherId || owner.value.data.sourceEpoch !== sourceEpoch) throw Object.assign(new Error('Publisher fenced'), { code: 'APP_PUBLISHER_FENCED' });
        const old = await store.read({ domain: 'runtime', guildId: applicationId, actorId: publisherId });
        const data = { runtime: storage.snapshots.get('runtime','nuviloview-bot'), sync_status: storage.snapshots.get('sync_status','nuviloview-sync') };
        if (checksum(old.data) !== checksum(data)) await store.write({ domain: 'runtime', guildId: applicationId, actorId: publisherId,
          expectedEpoch: old.epoch, expectedRevision: old.revision, expectedChecksum: old.checksum, acknowledgeUnconfirmed: true,
          requestId: `runtime:${checksum(data).slice(0,40)}`, data });
        state = 'CONSISTENT'; lastError = null; lastSuccess = now();
      } catch (error) {
        state = 'DEGRADED'; lastError = /^(APP|MDB|EC)_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'APP_PUBLICATION_UNAVAILABLE';
      }
    },
    status: () => ({ state, lastAttempt, lastSuccess, lastError, epoch: runtime.coordinator.epoch, sourceEpoch, journal: 'local-snapshots', retry: 'bounded-next-cycle' }),
  };
}
