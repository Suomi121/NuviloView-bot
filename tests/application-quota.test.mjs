import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from '../lib/multi-db/coordinator.mjs';
import { createTranslationQuota, translateWithQuota } from '../lib/multi-db/translation-quota.mjs';
import { applicationFixture } from './helpers/application-fixture.mjs';
const at = Date.parse('2026-10-28T00:00:00Z');
async function setup(t, baseline = 0) {
  const f = await applicationFixture(t); let clock = at;
  const quota = createTranslationQuota({ coordinator: f.coordinator, controlId: f.plan.controlId, now: () => clock });
  await quota.initialize({ period: '2026-10', limit: 100, baseline, reviewed: true, actorId: 'isolated-reviewer', reviewId: 'verified-test' });
  return { ...f, quota, tick: value => { clock = value; } };
}
test('Neon offline: reviewed baseline required, no implicit unused budget on new month', async t => {
  const f = await applicationFixture(t), quota = createTranslationQuota({ coordinator: f.coordinator, controlId: f.plan.controlId, now: () => at });
  await assert.rejects(quota.status(), { code: 'APP_QUOTA_UNCONFIRMED' });
  await assert.rejects(quota.initialize({ period: '2026-10', limit: 100, baseline: 0 }), { code: 'APP_QUOTA_REVIEW_REQUIRED' });
  const s = await setup(t, 20); assert.equal((await s.quota.status()).remainingCharacters, 80);
  s.tick(Date.parse('2026-11-01T00:00:00Z'));
  await assert.rejects(s.quota.status(), { code: 'APP_QUOTA_UNCONFIRMED' });
});
test('CAS concurrent reservations cannot exceed global budget, idempotency rejects changed input', async t => {
  const f = await setup(t, 10), id = checksum('request'), intent = checksum('input');
  const outcomes = await Promise.allSettled([id, checksum('second')].map(id => f.quota.reserve({ id, characters: 60, intent })));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.quota.status()).remainingCharacters, 30);
  const accepted = outcomes[0].status === 'fulfilled' ? id : checksum('second');
  await f.quota.reserve({ id: accepted, characters: 60, intent });
  assert.equal((await f.quota.status()).remainingCharacters, 30);
  await assert.rejects(f.quota.reserve({ id: accepted, characters: 61, intent }), { code: 'APP_QUOTA_IDEMPOTENCY_CONFLICT' });
});
test('actual existing adapter effect is called once; restart never repeats a dispatched request', async t => {
  const f = await setup(t), calls = [], args = { quota: f.quota, requestId: 'isolated-interaction', content: 'synthetic', targetLanguage: 'ja',
    fence: checksum('writer'), proveOwner: async () => {}, translate: async () => { calls.push(1); return { text: '合成訳' }; } };
  const result = await translateWithQuota(args); assert.equal(result.text, '合成訳'); assert.equal(calls.length, 1);
  const restarted = createTranslationQuota({ coordinator: f.coordinator, controlId: f.plan.controlId, now: () => at });
  await assert.rejects(translateWithQuota({ ...args, quota: restarted }), { code: 'APP_QUOTA_ALREADY_DISPATCHED' });
  assert.equal(calls.length, 1); assert.equal((await restarted.status()).remainingCharacters, 91);
});
test('ambiguous provider response consumes hold and cannot be refunded or retried', async t => {
  const f = await setup(t), fence = checksum('writer'), id = checksum({ requestId: 'failure' }); let calls = 0;
  await assert.rejects(translateWithQuota({ quota: f.quota, requestId: 'failure', content: 'synthetic', targetLanguage: 'ja', fence,
    proveOwner: async () => {}, translate: async () => { calls++; throw Error('secret raw upstream'); } }), { code: 'APP_TRANSLATION_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1); assert.equal((await f.quota.status()).unknown, 1);
  await assert.rejects(f.quota.settle({ period: '2026-10', id, outcome: 'REJECTED_BEFORE_DISPATCH' }), { code: 'APP_QUOTA_UNSAFE_REFUND' });
  assert.equal((await f.quota.status()).remainingCharacters, 91);
});
test('only never dispatched reservation is releasable and old fence cannot settle', async t => {
  const f = await setup(t), id = checksum('never-sent'), intent = checksum('input');
  const row = await f.quota.reserve({ id, characters: 15, intent });
  await f.quota.settle({ ...row, outcome: 'REJECTED_BEFORE_DISPATCH' });
  assert.equal((await f.quota.status()).remainingCharacters, 100);
  const row2 = await f.quota.reserve({ id: checksum('sent'), characters: 15, intent });
  await f.quota.dispatch({ ...row2, fence: checksum('new') });
  await assert.rejects(f.quota.settle({ ...row2, fence: checksum('old'), outcome: 'SUCCEEDED' }), { code: 'APP_QUOTA_FENCE' });
});
test('lost quorum or owner fencing prevents provider effect', async t => {
  const f = await setup(t); let called = false;
  const args = { quota: f.quota, requestId: 'fenced', content: 'test', targetLanguage: 'ja', fence: checksum('writer'),
    translate: async () => { called = true; } };
  await assert.rejects(translateWithQuota({ ...args, proveOwner: async () => { throw Error('fenced'); } }));
  f.faults.supabase = true;
  await assert.rejects(translateWithQuota({ ...args, proveOwner: async () => {} }));
  assert.equal(called, false);
});
