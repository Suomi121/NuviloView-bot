import { newsError } from '../news-contract.mjs';
import { normalizeSyncEnvelope } from '../sync/conflict-policy.mjs';

// Immutable dispatch authority and destination CAS share the fixed 3 voters.
// Worker replica health is NOT proof (or disproof) of a chosen quorum value.
export function createQuorumNewsControl(coordinator) {
  const destinations = coordinator.scoped('news-destination');
  const valid = e => {
    const match = /^news:([a-f0-9]{32}):(\d{16,22}):(\d+):(claim|result)$/.exec(e);
    if (!match) newsError('NEWS_CLAIM_ID');
    return { scope: `news-${match[1]}-${match[3]}`, guild: match[2], type: match[4] };
  };
  async function read(c, guild) {
    try { return await c.read(guild); }
    catch (e) { if (e.code === 'MDB_NOT_ENROLLED') return null; throw e; }
  }
  return Object.freeze({
    epoch:coordinator.epoch,recovery:Boolean(coordinator.recovery),
    async destination(guildId) {
      const state = await read(destinations, guildId);
      return { guildId, channelId: state?.value.data.channelId ?? null,
        revision: state?.value.revision ?? 0, checksum: state?.checksum ?? 'GENESIS',...(coordinator.recovery?{confirmed:Boolean(state)}:{}) };
    },
    async setDestination(ownerId, guildId, channelId) {
      const old = await this.destination(guildId);
      const state = await destinations.update({ guildId, expectedRevision: old.revision, expectedChecksum: old.checksum,
        actorId: ownerId, action: 'news:destination', requestId: `destination:${crypto.randomUUID()}`, data: { channelId } });
      return { guildId, channelId: state.value.data.channelId, revision: state.value.revision, checksum: state.checksum,...(coordinator.recovery?{confirmed:true}:{}) };
    },
    async claim(envelope) {
      const e = normalizeSyncEnvelope(envelope), { scope, guild } = valid(e.eventId), c = coordinator.scoped(scope);
      try {
        const state = await c.update({ guildId: guild, expectedRevision: 0, expectedChecksum: 'GENESIS',
          requestId: `claim:${e.payload.claimNonce}`, actorId: 'news-dispatch', action: 'news:claim',
          data: { claim: { eventId: e.eventId, checksum: e.checksum, payload: e.payload }, result: null } });
        if (state.value.data.claim.checksum !== e.checksum) newsError('NEWS_EXISTING_CLAIM');
        return e.checksum;
      } catch (error) {
        if (['MDB_REVISION_CONFLICT','MDB_IDEMPOTENCY_CONFLICT'].includes(error.code)) newsError('NEWS_EXISTING_CLAIM');
        throw error;
      }
    },
    async record(envelope) {
      const e = normalizeSyncEnvelope(envelope), { scope, guild } = valid(e.eventId), c = coordinator.scoped(scope);
      const old = await c.read(guild), data = old.value.data;
      if (data.claim.checksum !== e.payload.claimHash) newsError('NEWS_EXISTING_CLAIM');
      if (data.result) {
        if (data.result.checksum !== e.checksum) newsError('NEWS_CLOUD_OUTCOME_UNKNOWN');
        return e.checksum;
      }
      await c.update({ guildId: guild, expectedRevision: old.value.revision, expectedChecksum: old.checksum,
        requestId: `result:${e.checksum}`, actorId: 'news-dispatch', action: 'news:result',
        data: { ...data, result: { eventId: e.eventId, checksum: e.checksum, payload: e.payload } } });
      return e.checksum;
    },
    async verify(eventId, hash) {
      const { scope, guild, type } = valid(eventId);
      const record = (await coordinator.scoped(scope).read(guild)).value.data[type];
      return record?.eventId === eventId && record.checksum === hash;
    },
  });
}
