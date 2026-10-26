import { checksum, denied } from './coordinator.mjs';

// Only the explicitly fenced publisher may replace a rebuildable projection.
// sourceSequence is a durable LOCAL ingest watermark, not a wall-clock winner.
export async function publishApplicationProjection({ store, coordinator, guildId, actorId, publisherId, sourceSequence, sourceEpoch, snapshots, applicationId }) {
  const owner = await coordinator.scoped('application-publisher').read(applicationId);
  if (!publisherId || owner.value.data.publisherId !== publisherId || owner.value.data.sourceEpoch !== sourceEpoch) denied('APP_PUBLISHER_FENCED');
  if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 0 || !Array.isArray(snapshots) || snapshots.some(s => s.aggregateId !== guildId && !s.aggregateId?.startsWith(`v2:guild:${guildId}:`))) denied('APP_PROJECTION_BINDING');
  const old = await store.read({ domain: 'analytics', guildId, actorId });
  if (old.data && old.data.sourceEpoch !== sourceEpoch) denied('APP_PROJECTION_LINEAGE');
  if (old.data && old.data.sourceSequence > sourceSequence) denied('APP_STALE_SOURCE');
  const data = { sourceEpoch, sourceSequence, snapshots };
  if (old.data?.sourceSequence === sourceSequence && checksum(old.data) !== checksum(data)) denied('APP_SOURCE_CONFLICT');
  if (old.data && checksum(old.data) === checksum(data)) return old;
  // Recheck the authority after gathering data and immediately before CAS.
  const current = await coordinator.scoped('application-publisher').read(applicationId);
  if (current.checksum !== owner.checksum) denied('APP_PUBLISHER_FENCED');
  return store.write({ domain: 'analytics', guildId, actorId, expectedEpoch: old.epoch, expectedRevision: old.revision, expectedChecksum: old.checksum,
    acknowledgeUnconfirmed: true, requestId: `projection:${checksum(data).slice(0,40)}`, data });
}

export function createApplicationProjectionRouter({ store, actorId, controlId, now = Date.now, intervalMs = 900000 }) {
  function meta(record, snapshot) {
    const age = now() - Number(snapshot?.generatedAt ?? 0);
    const freshness = !snapshot ? 'unavailable' : age <= intervalMs * 1.5 ? 'fresh' : age <= intervalMs * 4 ? 'stale' : 'very_stale';
    return { provider: 'cloud-quorum', snapshotVersion: snapshot?.snapshotVersion ?? null, checksum: snapshot?.checksum ?? null,
      lastUpdatedAt: snapshot?.generatedAt ?? null, observedAt: null, observationSource: null, nextUpdateAt: now() + intervalMs,
      freshness, degraded: freshness !== 'fresh', lastKnownGood: false, truncated: false, epoch: record.epoch, revision: record.revision, configurationState: record.state };
  }
  async function bundle(guildId) { return store.read({ domain: 'analytics', guildId, actorId }); }
  async function readSnapshot({ snapshotType, aggregateId }) {
    const guildId = snapshotType === 'guild_status' ? aggregateId : /^v2:guild:(\d{16,22}):/.exec(aggregateId)?.[1];
    if (!guildId) {
      if (!['runtime','sync_status'].includes(snapshotType)) denied('APP_PROJECTION_BINDING');
      const record = await store.read({ domain: 'runtime', guildId: controlId, actorId });
      const snapshot = record.data?.[snapshotType] ?? null;
      return { available: Boolean(snapshot), snapshot, metadata: meta(record,snapshot), attempts: ['cloud-quorum'] };
    }
    const record = await bundle(guildId), snapshot = record.data?.snapshots.find(s => s.snapshotType === snapshotType && s.aggregateId === aggregateId) ?? null;
    return { available: Boolean(snapshot), snapshot, metadata: meta(record,snapshot), attempts: ['cloud-quorum'] };
  }
  return { readSnapshot,
    async readAnalyticsBundle({ guildId, dateFrom, dateTo, limit = 50000 }) {
      const record = await bundle(guildId), current = record.data?.snapshots.find(s => s.aggregateId === `v2:guild:${guildId}:current`) ?? null;
      const snapshots = (record.data?.snapshots ?? []).filter(s => s.snapshotType === 'analytics' && (!dateFrom || !s.payload?.dateUtc || s.payload.dateUtc >= dateFrom) && (!dateTo || !s.payload?.dateUtc || s.payload.dateUtc <= dateTo));
      if (snapshots.length > limit) denied('APP_CAPACITY');
      return { available: Boolean(current), current, snapshots, metadata: meta(record,current), attempts: ['cloud-quorum'] };
    },
    readRuntimeSnapshot: () => readSnapshot({ snapshotType: 'runtime', aggregateId: 'nuviloview-bot' }),
    readSyncStatusSnapshot: () => readSnapshot({ snapshotType: 'sync_status', aggregateId: 'nuviloview-sync' }),
  };
}
