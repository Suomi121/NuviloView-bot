import { normalizeSyncEnvelope } from './sync/conflict-policy.mjs';
import { newsError } from './news-contract.mjs';

// Fixed, distinct existing replica stores. A health ping never grants send rights.
// Immutable INSERT-if-absent + checksum verification elects at most one random
// claim owner: two different nonces cannot both acquire intersecting 2/3 quorums.
export function createNewsCloudGuard({ registry, timeoutMs = 5000 }) {
  const providers = registry.list().filter(p => p.isEnabled());
  if (new Set(providers.map(p => p.id)).size !== providers.length || providers.length < 2 ||
      providers.some(p => !['neon','supabase','turso'].includes(p.id))) newsError('NEWS_CLOUD_CONFIG');
  async function bounded(fn) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('NEWS_CLOUD_TIMEOUT')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function checks(eventId) {
    const replies = await Promise.all(providers.map(async p => {
      try { return { id: p.id, hash: (await bounded(() => p.getEventChecksums([eventId]))).get(eventId) ?? null }; }
      catch { return null; }
    }));
    const available = replies.filter(Boolean);
    if (available.length < 2) newsError('NEWS_CLOUD_UNAVAILABLE');
    return available;
  }
  async function commit(envelope) {
    const results = await Promise.all(providers.map(async p => {
      try {
        const r = await bounded(() => p.pushEvents([envelope]));
        return r.succeededEventIds?.includes(envelope.eventId) === true;
      } catch { return false; }
    }));
    if (results.filter(Boolean).length < 2) newsError('NEWS_CLOUD_OUTCOME_UNKNOWN');
  }
  return Object.freeze({
    async claim(envelope) {
      const e = normalizeSyncEnvelope(envelope);
      if ((await checks(e.eventId)).some(r => r.hash)) newsError('NEWS_EXISTING_CLAIM');
      await commit(e);
      return e.checksum;
    },
    async record(envelope) { const e = normalizeSyncEnvelope(envelope); await commit(e); return e.checksum; },
    async verify(eventId, hash) {
      const replies = await checks(eventId);
      if (replies.some(r => r.hash && r.hash !== hash)) return false;
      return replies.filter(r => r.hash === hash).length >= 2;
    },
  });
}
