import { checksum, denied } from './coordinator.mjs';

const requestPattern = /^[a-f0-9]{64}$/;
export function translationPeriod(at = Date.now()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) denied('APP_QUOTA_INPUT');
  return date.toISOString().slice(0, 7);
}

// The translation service's existing quota is global, not per Guild/user.
// A month is a separate quorum log. Held/UNKNOWN reservations consume budget.
// No clock-based expiry refunds ambiguous external API calls.
export function createTranslationQuota({ coordinator, controlId, now = Date.now }) {
  const log = period => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period ?? '')) denied('APP_QUOTA_INPUT');
    return coordinator.scoped(`translation-${period}`);
  };
  async function read(period) {
    try { return await log(period).read(controlId); }
    catch (error) { if (error.code === 'MDB_NOT_ENROLLED') denied('APP_QUOTA_UNCONFIRMED'); throw error; }
  }
  const remaining = data => data.limit - data.baseline - Object.values(data.reservations)
    .filter(r => r.state !== 'RELEASED').reduce((sum, r) => sum + r.characters, 0);
  async function change(period, id, action, mutate) {
    if (!requestPattern.test(id ?? '')) denied('APP_QUOTA_INPUT');
    const state = await read(period), data = structuredClone(state.value.data);
    const changed = mutate(data);
    if (changed) await log(period).update({ guildId: controlId, expectedRevision: state.value.revision,
      expectedChecksum: state.checksum, actorId: 'translation-runtime', requestId: `${action}:${id}`,
      action: `translation:${action}`, data });
    return { period, id, remainingCharacters: remaining(data), reservation: data.reservations[id] };
  }
  return Object.freeze({
    // Only an explicitly reviewed non-runtime migration/provisioning tool may
    // call this. A missing historical balance is never treated as unused quota.
    async initialize({ period, limit, baseline, reviewed, actorId, reviewId }) {
      if (reviewed !== true || !Number.isSafeInteger(limit) || limit < 1 || limit > 600000 ||
          !Number.isSafeInteger(baseline) || baseline < 0 || baseline > limit ||
          !/^[a-zA-Z0-9:_-]{1,80}$/.test(reviewId ?? '') || !/^[a-zA-Z0-9:_-]{1,128}$/.test(actorId ?? '')) denied('APP_QUOTA_REVIEW_REQUIRED');
      return log(period).update({ guildId: controlId, expectedRevision: 0, expectedChecksum: 'GENESIS',
        actorId, requestId: `initialize:${reviewId}`, action: 'translation:reviewed-baseline',
        data: { version: 1, period, limit, baseline, reviewId, reservations: {} } });
    },
    async reserve({ id, characters, intent, period = translationPeriod(now()) }) {
      if (!Number.isSafeInteger(characters) || characters < 1 || !requestPattern.test(intent ?? '') || period !== translationPeriod(now())) denied('APP_QUOTA_INPUT');
      return change(period, id, 'reserve', data => {
        if (data.reservations[id]) {
          if (data.reservations[id].characters !== characters || data.reservations[id].intent !== intent) denied('APP_QUOTA_IDEMPOTENCY_CONFLICT');
          return false;
        }
        if (Object.keys(data.reservations).length >= 2000) denied('APP_QUOTA_CAPACITY');
        if (remaining(data) < characters) denied('APP_QUOTA_EXHAUSTED');
        data.reservations[id] = { characters, intent, state: 'RESERVED' }; return true;
      });
    },
    async dispatch({ period, id, fence }) {
      if (!requestPattern.test(fence ?? '')) denied('APP_QUOTA_INPUT');
      return change(period, id, 'dispatch', data => {
        const r = data.reservations[id];
        if (!r || r.state !== 'RESERVED') denied('APP_QUOTA_ALREADY_DISPATCHED');
        r.state = 'DISPATCHED'; r.fence = fence; return true;
      });
    },
    async settle({ period, id, fence, outcome }) {
      if (!['SUCCEEDED', 'UNKNOWN', 'REJECTED_BEFORE_DISPATCH'].includes(outcome)) denied('APP_QUOTA_INPUT');
      return change(period, id, `settle-${outcome}`, data => {
        const r = data.reservations[id];
        if (!r) denied('APP_QUOTA_INPUT');
        if (outcome === 'REJECTED_BEFORE_DISPATCH') {
          if (r.state === 'RELEASED') return false;
          if (r.state !== 'RESERVED') denied('APP_QUOTA_UNSAFE_REFUND');
          r.state = 'RELEASED'; return true;
        }
        if (r.fence !== fence || !requestPattern.test(fence ?? '')) denied('APP_QUOTA_FENCE');
        if (r.state === outcome) return false;
        if (r.state !== 'DISPATCHED') denied('APP_QUOTA_TERMINAL');
        r.state = outcome; return true;
      });
    },
    async status(period = translationPeriod(now())) {
      const state = await read(period);
      return { epoch: coordinator.epoch, period, revision: state.value.revision,
        remainingCharacters: remaining(state.value.data),
        unknown: Object.values(state.value.data.reservations).filter(r => ['UNKNOWN','DISPATCHED'].includes(r.state)).length };
    },
  });
}

// Holds are durable before the external effect. A process death after dispatch
// cannot authorize a repeat. No plaintext input/output is persisted here.
export async function translateWithQuota({ quota, requestId, content, targetLanguage, proveOwner, translate, fence }) {
  const id = checksum({ requestId }), intent = checksum({ content, targetLanguage });
  const reserved = await quota.reserve({ id, characters: [...content].length, intent });
  await proveOwner();
  await quota.dispatch({ ...reserved, fence });
  await proveOwner();
  let result;
  try { result = await translate(); }
  catch { await quota.settle({ ...reserved, fence, outcome: 'UNKNOWN' }).catch(() => {}); denied('APP_TRANSLATION_OUTCOME_UNKNOWN'); }
  await quota.settle({ ...reserved, fence, outcome: 'SUCCEEDED' });
  return { ...result, remainingCharacters: reserved.remainingCharacters };
}
