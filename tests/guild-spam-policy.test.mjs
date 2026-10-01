import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_GUILD_SPAM_POLICY,
  canAccessGuildSpamPolicy,
  countSpamLinks,
  countSpamMentions,
  getChangedSpamPolicyFields,
  createGuildSpamDetectionTracker,
  createGuildSpamPolicyCache,
  getSpamPolicyPreset,
  normalizeGuildSpamPolicy,
  parseGuildSpamPolicyRow,
  policyFromPreset,
  resolveSpamPolicyAction,
  shouldApplyGuildSpamPolicy,
  withCustomPresetOnManualChange,
} from '../lib/guild-spam-policy.mjs';

const guildA = '11111111111111111';
const guildB = '22222222222222222';
const botSource = readFileSync(new URL('../discord-bot.mjs', import.meta.url), 'utf8');
const user = '33333333333333333';
const channelA = '44444444444444444';
const channelB = '55555555555555555';
const channelC = '66666666666666666';
const roleA = '77777777777777777';

test('policy API access is restricted to Guilds in the authenticated Manage Guild list', () => {
  const managedGuilds = [{ id: guildA }];
  assert.equal(canAccessGuildSpamPolicy(managedGuilds, guildA), true);
  assert.equal(canAccessGuildSpamPolicy(managedGuilds, guildB), false);
  assert.equal(canAccessGuildSpamPolicy([], guildA), false);
  assert.equal(canAccessGuildSpamPolicy(managedGuilds, 'not-a-guild'), false);
});

test('NORMAL is based on the existing three messages / five seconds threshold', () => {
  assert.equal(DEFAULT_GUILD_SPAM_POLICY.preset, 'NORMAL');
  assert.equal(DEFAULT_GUILD_SPAM_POLICY.messageCountThreshold, 3);
  assert.equal(DEFAULT_GUILD_SPAM_POLICY.messageWindowSeconds, 5);
  assert.equal(getSpamPolicyPreset('NORMAL').messageCountThreshold, 3);
});

test('preset selection applies preset thresholds and manual threshold edit converts to CUSTOM', () => {
  const strict = policyFromPreset('STRICT');
  assert.equal(strict.messageWindowSeconds, 3);
  assert.equal(strict.crossChannelThreshold, 2);
  const custom = withCustomPresetOnManualChange(strict, 'messageCountThreshold', 7);
  assert.equal(custom.preset, 'CUSTOM');
  assert.equal(custom.messageCountThreshold, 7);
});

test('policy normalization rejects invalid thresholds, windows, actions, and IDs', () => {
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, messageCountThreshold: 0 }), null);
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, messageWindowSeconds: 301 }), null);
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, action: 'TIMEOUT' }), null);
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, preset: 'NORMAL', messageCountThreshold: 8 }), null);
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, ignoredRoleIds: ['not-a-snowflake'] }), null);
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, ignoredChannelIds: Array.from({ length: 51 }, (_, i) => String(10000000000000000 + i)) }), null);
});

test('database row parsing validates and normalizes values', () => {
  const row = parseGuildSpamPolicyRow({
    enabled: true, preset: 'NORMAL', message_count_threshold: 3, message_window_seconds: 5,
    duplicate_count_threshold: 3, duplicate_window_seconds: 20, mention_count_threshold: 5,
    mention_window_seconds: 10, link_count_threshold: 4, link_window_seconds: 20,
    cross_channel_threshold: 3, cross_channel_window_seconds: 15, action: 'ALERT',
    ignore_bots: false, ignore_admins: false, ignored_role_ids: [roleA],
    ignored_channel_ids: [], updated_at: new Date(0), updated_by: 'operator',
  });
  assert.equal(row.messageCountThreshold, 3);
  assert.deepEqual(row.ignoredRoleIds, [roleA]);
  assert.equal(parseGuildSpamPolicyRow({ preset: 'NORMAL' }), null);
});

test('missing Guild policy uses legacy/default source; cache coalesces and invalidates', async () => {
  let calls = 0;
  let clock = 0;
  let value = null;
  const cache = createGuildSpamPolicyCache({
    ttlMs: 30_000,
    now: () => clock,
    loadPolicy: async () => { calls += 1; return value; },
    logger: { warn() {} },
  });
  const first = await cache.get(guildA);
  assert.equal(first.isCustom, false);
  assert.equal(first.source, 'default');
  await cache.get(guildA);
  assert.equal(calls, 1);
  value = DEFAULT_GUILD_SPAM_POLICY;
  cache.invalidate(guildA);
  assert.equal((await cache.get(guildA)).isCustom, true);
  assert.equal(calls, 2);
  clock = 30_001;
  await cache.get(guildA);
  assert.equal(calls, 3);
});

test('database failures fall back and are safely cached', async () => {
  let calls = 0;
  const cache = createGuildSpamPolicyCache({
    loadPolicy: async () => { calls += 1; throw Object.assign(new Error('private detail'), { code: 'ETIMEDOUT' }); },
    logger: { warn(message) { assert.match(message, /ETIMEDOUT/); assert.doesNotMatch(message, /private detail/); } },
  });
  assert.equal((await cache.get(guildA)).source, 'fallback');
  assert.equal((await cache.get(guildA)).isCustom, false);
  assert.equal(calls, 1);
});

test('invalidating a Guild while its policy read is in flight cannot cache the stale result', async () => {
  const resolvers = [];
  let calls = 0;
  const cache = createGuildSpamPolicyCache({
    loadPolicy: () => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    },
    logger: { warn() {} },
  });

  const staleRead = cache.get(guildA);
  cache.invalidate(guildA);
  const currentRead = cache.get(guildA);
  const customPolicy = normalizeGuildSpamPolicy(DEFAULT_GUILD_SPAM_POLICY);
  resolvers[1](customPolicy);
  assert.equal((await currentRead).source, 'guild');
  resolvers[0](null);
  await staleRead;
  assert.equal((await cache.get(guildA)).source, 'guild');
  assert.equal(calls, 2);
});

test('Guild A detection state never contributes to Guild B', () => {
  const tracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  tracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'one', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 1 });
  tracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'two', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 2 });
  assert.equal(tracker.record({ guildId: guildB, userId: user, channelId: channelA, content: 'three', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 3 }).detected, false);
  assert.equal(tracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'four', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 4 }).detected, true);
});

test('Guild removal can clear only that Guild detection windows and cooldowns', () => {
  const tracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  tracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'one', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 1 });
  tracker.record({ guildId: guildB, userId: user, channelId: channelB, content: 'one', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 1 });
  tracker.forgetGuild(guildA);
  assert.equal(tracker.trackedWindowCount, 1);
  assert.equal(tracker.cooldownCount, 0);
  assert.equal(tracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'two', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 2 }).count, 1);
  assert.equal(tracker.trackedWindowCount, 2);
});

test('guildDelete invalidates transient spam state without deleting persisted policy or audit rows', () => {
  const handler = botSource.match(/client\.on\("guildDelete", \(guild\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(handler, 'guildDelete handler is present');
  assert.match(handler, /guildSpamPolicyCache\.invalidate\(guild\.id\)/);
  assert.match(handler, /guildSpamDetectionTracker\.forgetGuild\(guild\.id\)/);
  assert.match(handler, /spamTracker\.forgetGuild\(guild\.id\)/);
  assert.doesNotMatch(handler, /guild_spam_policy|guild_spam_policy_audit|\bDELETE\b|\bTRUNCATE\b/);
});

test('duplicate, mention, link, and cross-channel policies emit independent signals', () => {
  const strictMessage = { ...DEFAULT_GUILD_SPAM_POLICY, messageCountThreshold: 99, duplicateCountThreshold: 3, mentionCountThreshold: 99, linkCountThreshold: 99, crossChannelThreshold: 99 };
  const duplicateTracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  for (let i = 0; i < 2; i += 1) duplicateTracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'repeat me', policy: strictMessage, timestamp: i + 1 });
  assert.deepEqual(duplicateTracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'repeat me', policy: strictMessage, timestamp: 3 }).signals, ['duplicates']);

  const mentionTracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  const mentionPolicy = { ...strictMessage, mentionCountThreshold: 4 };
  assert.equal(mentionTracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'hello', mentionCount: 4, policy: mentionPolicy, timestamp: 1 }).signals[0], 'mentions');

  const linkTracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  const linkPolicy = { ...strictMessage, linkCountThreshold: 2 };
  assert.equal(linkTracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'links', linkCount: 2, policy: linkPolicy, timestamp: 1 }).signals[0], 'links');

  const channelTracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  const channelPolicy = { ...strictMessage, crossChannelThreshold: 3 };
  channelTracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'a', policy: channelPolicy, timestamp: 1 });
  channelTracker.record({ guildId: guildA, userId: user, channelId: channelB, content: 'b', policy: channelPolicy, timestamp: 2 });
  assert.equal(channelTracker.record({ guildId: guildA, userId: user, channelId: channelC, content: 'c', policy: channelPolicy, timestamp: 3 }).signals[0], 'cross_channel');
});

test('ignored channel does not enter counters; role/admin/bot exclusions are applied safely', () => {
  const tracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  const policy = { ...DEFAULT_GUILD_SPAM_POLICY, ignoredChannelIds: [channelA], ignoredRoleIds: [roleA], ignoreBots: true, ignoreAdmins: true };
  assert.equal(tracker.record({ guildId: guildA, userId: user, channelId: channelA, content: 'spam', policy, timestamp: 1 }).excluded, true);
  assert.equal(tracker.trackedWindowCount, 0);
  assert.equal(shouldApplyGuildSpamPolicy({ policy, channelId: channelB, roleIds: [roleA] }).reason, 'role_exclusion');
  assert.equal(shouldApplyGuildSpamPolicy({ policy, channelId: channelB, isBot: true }).reason, 'bot_exclusion');
  assert.equal(shouldApplyGuildSpamPolicy({ policy, channelId: channelB, isAdmin: true }).reason, 'admin_exclusion');
  assert.equal(shouldApplyGuildSpamPolicy({ policy, channelId: channelB, isOwnBot: true }).track, false);
  assert.equal(shouldApplyGuildSpamPolicy({ policy, channelId: channelB, isWebhook: true }).track, false);
});

test('Action selection is limited to non-destructive LOG_ONLY, ALERT, and INCIDENT', () => {
  for (const action of ['LOG_ONLY', 'ALERT', 'INCIDENT']) {
    assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, action }).action, action);
  }
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, action: 'DELETE' }), null);
});

test('link and mention signals are counted without retaining raw message content', () => {
  assert.equal(countSpamLinks('Visit https://example.test and discord.gg/abc'), 2);
  assert.equal(countSpamLinks('ordinary text only'), 0);
  assert.equal(countSpamMentions({ userCount: 2, roleCount: 1, everyone: true }), 4);
  assert.equal(countSpamMentions({ userCount: 500 }), 200);
});

test('unconfigured Guilds preserve legacy auto-timeout; custom policy separates action from detection', () => {
  assert.equal(resolveSpamPolicyAction({ isCustom: false, policy: DEFAULT_GUILD_SPAM_POLICY }), 'LEGACY_TIMEOUT');
  assert.equal(resolveSpamPolicyAction({ isCustom: true, policy: { ...DEFAULT_GUILD_SPAM_POLICY, action: 'LOG_ONLY' } }), 'LOG_ONLY');
  assert.equal(resolveSpamPolicyAction({ isCustom: false, source: 'fallback', policy: DEFAULT_GUILD_SPAM_POLICY }), 'LOG_ONLY');
});

test('policy audit records changed field names only, not setting values or identity data', () => {
  const changed = getChangedSpamPolicyFields(DEFAULT_GUILD_SPAM_POLICY, { ...DEFAULT_GUILD_SPAM_POLICY, messageCountThreshold: 9, updatedBy: 'not-a-policy-field' });
  assert.deepEqual(changed, ['messageCountThreshold']);
  assert.equal(changed.includes('updatedBy'), false);
});
