import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_GUILD_SPAM_POLICY,
  SPAM_POLICY_MODULES,
  applySpamProtectionCommand,
  applySpamProtectionStrength,
  createGuildSpamDetectionTracker,
  getSpamPolicyAuditChanges,
  isSpamProtectionActive,
  normalizeGuildSpamPolicy,
  parseGuildSpamPolicyRow,
  spamProtectionLevel,
  spamPolicyToDatabaseFields,
  strengthToSpamPolicy,
  withCustomPresetOnManualChange,
} from '../lib/guild-spam-policy.mjs';

const guildId = '11111111111111111';
const userId = '22222222222222222';
const channelA = '33333333333333333';
const channelB = '44444444444444444';
const bot = readFileSync(new URL('../discord-bot.mjs', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../components/guild-spam-policy-panel.tsx', import.meta.url), 'utf8');
const route = readFileSync(new URL('../app/api/guilds/[guildId]/security/spam-policy/route.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../scripts/migrations/20261001-guild-spam-protection-controls.sql', import.meta.url), 'utf8');

test('strength boundaries map deterministically and reject non-integers/out-of-range values', () => {
  const levels = new Map([[0, 'OFF'], [1, 'RELAXED'], [33, 'RELAXED'], [34, 'NORMAL'], [50, 'NORMAL'], [66, 'NORMAL'], [67, 'STRICT'], [100, 'STRICT']]);
  for (const [strength, expected] of levels) {
    const result = strengthToSpamPolicy(strength);
    assert.equal(spamProtectionLevel(strength), expected);
    assert.equal(result.strength, strength);
    assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, ...result }).strength, strength);
  }
  for (const invalid of [-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '50']) {
    assert.equal(strengthToSpamPolicy(invalid), null);
    assert.equal(applySpamProtectionStrength(DEFAULT_GUILD_SPAM_POLICY, invalid), null);
  }
  assert.equal(normalizeGuildSpamPolicy({ ...DEFAULT_GUILD_SPAM_POLICY, strength: '50' }), null);
});

test('higher strength monotonically increases spam sensitivity and clamps all thresholds/windows', () => {
  const low = strengthToSpamPolicy(1);
  const normal = strengthToSpamPolicy(50);
  const high = strengthToSpamPolicy(100);
  for (const [threshold, window] of [
    ['messageCountThreshold', 'messageWindowSeconds'],
    ['duplicateCountThreshold', 'duplicateWindowSeconds'],
    ['mentionCountThreshold', 'mentionWindowSeconds'],
    ['linkCountThreshold', 'linkWindowSeconds'],
    ['crossChannelThreshold', 'crossChannelWindowSeconds'],
  ]) {
    assert.ok(low[threshold] >= normal[threshold]);
    assert.ok(high[threshold] <= normal[threshold]);
    assert.ok(low[window] <= normal[window]);
    assert.ok(high[window] >= normal[window]);
    for (const value of [low[threshold], normal[threshold], high[threshold]]) assert.ok(value >= 1 && value <= 100);
    for (const value of [low[window], normal[window], high[window]]) assert.ok(value >= 1 && value <= 300);
  }
  let previous = strengthToSpamPolicy(0);
  for (let strength = 1; strength <= 100; strength += 1) {
    const current = strengthToSpamPolicy(strength);
    for (const key of ['messageCountThreshold', 'duplicateCountThreshold', 'mentionCountThreshold', 'linkCountThreshold', 'crossChannelThreshold']) assert.ok(current[key] <= previous[key], `${key} at ${strength}`);
    for (const key of ['messageWindowSeconds', 'duplicateWindowSeconds', 'mentionWindowSeconds', 'linkWindowSeconds', 'crossChannelWindowSeconds']) assert.ok(current[key] >= previous[key], `${key} at ${strength}`);
    previous = current;
  }
  assert.deepEqual(
    Object.fromEntries(Object.keys(DEFAULT_GUILD_SPAM_POLICY).filter((key) => /Threshold|Seconds/.test(key)).map((key) => [key, normal[key]])),
    Object.fromEntries(Object.keys(DEFAULT_GUILD_SPAM_POLICY).filter((key) => /Threshold|Seconds/.test(key)).map((key) => [key, DEFAULT_GUILD_SPAM_POLICY[key]])),
  );
});

test('master OFF and strength zero skip spam detection but preserve saved module switches', () => {
  const offMaster = { ...DEFAULT_GUILD_SPAM_POLICY, enabled: false, duplicateEnabled: false };
  const offStrength = { ...DEFAULT_GUILD_SPAM_POLICY, strength: 0 };
  assert.equal(isSpamProtectionActive(offMaster), false);
  assert.equal(isSpamProtectionActive(offStrength), false);
  assert.equal(offMaster.duplicateEnabled, false);
  const tracker = createGuildSpamDetectionTracker();
  tracker.record({ guildId, userId, channelId: channelA, content: 'before-off', policy: DEFAULT_GUILD_SPAM_POLICY, timestamp: 0 });
  for (const policy of [offMaster, offStrength]) {
    const result = tracker.record({ guildId, userId, channelId: channelA, content: 'repeat', policy, timestamp: 1 });
    assert.deepEqual(result.signals, []);
    assert.equal(result.excluded, true);
  }
  assert.equal(tracker.trackedWindowCount, 0);
  assert.equal(isSpamProtectionActive({ ...offMaster, enabled: true }), true);
});

test('each module can be disabled independently without emitting that signal', () => {
  const fixtures = [
    ['messageBurstEnabled', (tracker, policy) => [1, 2, 3].map((n) => tracker.record({ guildId, userId, channelId: channelA, content: `m${n}`, policy, timestamp: n }))],
    ['duplicateEnabled', (tracker, policy) => [1, 2, 3].map((n) => tracker.record({ guildId, userId, channelId: channelA, content: 'repeat', policy, timestamp: n }))],
    ['mentionEnabled', (tracker, policy) => [1, 2, 3].map((n) => tracker.record({ guildId, userId, channelId: channelA, content: 'mentions', mentionCount: 2, policy, timestamp: n }))],
    ['linkEnabled', (tracker, policy) => [1, 2, 3].map((n) => tracker.record({ guildId, userId, channelId: channelA, content: 'links', linkCount: 2, policy, timestamp: n }))],
    ['crossChannelEnabled', (tracker, policy) => [channelA, channelB, '55555555555555555'].map((channelId, index) => tracker.record({ guildId, userId, channelId, content: `m${index}`, policy, timestamp: index + 1 }))],
  ];
  for (const [module, makeRecords] of fixtures) {
    const policy = { ...DEFAULT_GUILD_SPAM_POLICY, messageCountThreshold: 2, duplicateCountThreshold: 2, mentionCountThreshold: 2, linkCountThreshold: 2, crossChannelThreshold: 2, [module]: false };
    const tracker = createGuildSpamDetectionTracker();
    const results = makeRecords(tracker, policy);
    assert.ok(results.every((result) => !result.signals.includes(({ messageBurstEnabled: 'messages', duplicateEnabled: 'duplicates', mentionEnabled: 'mentions', linkEnabled: 'links', crossChannelEnabled: 'cross_channel' })[module])), module);
  }
  assert.deepEqual(SPAM_POLICY_MODULES, ['messageBurstEnabled', 'duplicateEnabled', 'mentionEnabled', 'linkEnabled', 'crossChannelEnabled']);
});

test('events observed while a module is OFF cannot trigger it immediately after re-enable', () => {
  const tracker = createGuildSpamDetectionTracker({ cooldownMs: 60_000 });
  const normal = { ...DEFAULT_GUILD_SPAM_POLICY, messageCountThreshold: 99, duplicateCountThreshold: 3, mentionCountThreshold: 99, linkCountThreshold: 99, crossChannelThreshold: 99 };
  tracker.record({ guildId, userId, channelId: channelA, content: 'same', policy: normal, timestamp: 1 });
  tracker.record({ guildId, userId, channelId: channelA, content: 'same', policy: normal, timestamp: 2 });
  tracker.record({ guildId, userId, channelId: channelB, content: 'same', policy: { ...normal, duplicateEnabled: false }, timestamp: 3 });
  const afterReenable = tracker.record({ guildId, userId, channelId: channelA, content: 'same', policy: normal, timestamp: 4 });
  assert.equal(afterReenable.signals.includes('duplicates'), false);
});

test('custom threshold edit changes mode and slider returns to strength-derived mapping', () => {
  const custom = withCustomPresetOnManualChange(DEFAULT_GUILD_SPAM_POLICY, 'messageCountThreshold', 7);
  assert.equal(custom.mode, 'CUSTOM');
  assert.equal(custom.preset, 'CUSTOM');
  const restored = applySpamProtectionStrength(custom, 67);
  assert.equal(restored.mode, 'STRENGTH');
  assert.equal(restored.strength, 67);
  assert.equal(restored.messageCountThreshold, strengthToSpamPolicy(67).messageCountThreshold);
  assert.equal(normalizeGuildSpamPolicy({ ...restored, messageCountThreshold: 100 }), null);
});

test('legacy policy rows without new columns preserve normal behavior and default all modules on', () => {
  const legacy = parseGuildSpamPolicyRow({
    enabled: true, preset: 'NORMAL', message_count_threshold: 3, message_window_seconds: 5,
    duplicate_count_threshold: 3, duplicate_window_seconds: 20, mention_count_threshold: 5,
    mention_window_seconds: 10, link_count_threshold: 4, link_window_seconds: 20,
    cross_channel_threshold: 3, cross_channel_window_seconds: 15, action: 'ALERT',
    ignore_bots: false, ignore_admins: false, ignored_role_ids: [], ignored_channel_ids: [],
  });
  assert.equal(legacy.strength, 50);
  assert.equal(legacy.mode, 'STRENGTH');
  assert.ok(SPAM_POLICY_MODULES.every((module) => legacy[module] === true));
  assert.deepEqual(strengthToSpamPolicy(50), {
    strength: 50, mode: 'STRENGTH', preset: 'NORMAL',
    messageCountThreshold: 3, messageWindowSeconds: 5,
    duplicateCountThreshold: 3, duplicateWindowSeconds: 20,
    mentionCountThreshold: 5, mentionWindowSeconds: 10,
    linkCountThreshold: 4, linkWindowSeconds: 20,
    crossChannelThreshold: 3, crossChannelWindowSeconds: 15,
  });
});

test('audit includes before/after values for only changed policy fields', () => {
  assert.deepEqual(getSpamPolicyAuditChanges(DEFAULT_GUILD_SPAM_POLICY, { ...DEFAULT_GUILD_SPAM_POLICY, enabled: false, linkEnabled: false }), {
    enabled: { before: true, after: false },
    linkEnabled: { before: true, after: false },
  });
});

test('command operations change only the requested Guild field and preserve sibling modules', () => {
  const base = { ...DEFAULT_GUILD_SPAM_POLICY, linkEnabled: false };
  assert.equal(applySpamProtectionCommand(base, 'off').enabled, false);
  assert.equal(applySpamProtectionCommand({ ...base, enabled: false }, 'on').enabled, true);
  assert.equal(applySpamProtectionCommand(base, 'level', 67).strength, 67);
  for (const [operation, field] of [['messages', 'messageBurstEnabled'], ['duplicate', 'duplicateEnabled'], ['mentions', 'mentionEnabled'], ['links', 'linkEnabled'], ['cross-channel', 'crossChannelEnabled']]) {
    const updated = applySpamProtectionCommand(base, operation, true);
    assert.equal(updated[field], true, operation);
    assert.equal(updated.linkEnabled, operation === 'links' ? true : false, `${operation} retains link setting`);
  }
  assert.equal(applySpamProtectionCommand(base, 'links', 'false'), null);
  assert.equal(applySpamProtectionCommand(base, 'other', true), null);
});

test('only changed command fields become database patch; strength patch shares deterministic mapping', () => {
  const start = { ...DEFAULT_GUILD_SPAM_POLICY, linkEnabled: false };
  const toggled = applySpamProtectionCommand(start, 'messages', false);
  assert.deepEqual(spamPolicyToDatabaseFields(toggled, ['messageBurstEnabled']), { message_burst_enabled: false });
  const adjusted = applySpamProtectionCommand(start, 'level', 67);
  const changed = Object.keys(adjusted).filter((key) => JSON.stringify(adjusted[key] ?? null) !== JSON.stringify(start[key] ?? null));
  const db = spamPolicyToDatabaseFields(adjusted, [...changed, 'strength', 'mode', 'messageCountThreshold', 'messageWindowSeconds', 'duplicateCountThreshold', 'duplicateWindowSeconds', 'mentionCountThreshold', 'mentionWindowSeconds', 'linkCountThreshold', 'linkWindowSeconds', 'crossChannelThreshold', 'crossChannelWindowSeconds']);
  assert.equal(db.strength, 67);
  assert.equal(db.policy_mode, 'STRENGTH');
  assert.equal(db.message_count_threshold, strengthToSpamPolicy(67).messageCountThreshold);
  assert.equal(db.link_enabled, undefined);
});

test('manual custom threshold clears slider strength and can return to shared slider mapping', () => {
  const custom = withCustomPresetOnManualChange(DEFAULT_GUILD_SPAM_POLICY, 'messageWindowSeconds', 7);
  assert.equal(custom.strength, null);
  assert.equal(custom.mode, 'CUSTOM');
  const fromSlider = applySpamProtectionStrength(custom, 34);
  assert.equal(fromSlider.mode, 'STRENGTH');
  assert.equal(fromSlider.strength, 34);
});

test('API updates are serialized per Guild and persist module/strength fields with before-after audit', () => {
  assert.match(route, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(route, /"strength", "policy_mode", "message_burst_enabled"/);
  assert.match(route, /"cross_channel_enabled"/);
  assert.match(route, /"changed_fields", "changes"/);
  assert.match(route, /getSpamPolicyAuditChanges\(previous, policy\)/);
  assert.match(route, /getManagedGuilds/);
  assert.match(route, /canAccessGuildSpamPolicy/);
});

test('Discord reset keeps an audit and restores the shared default without accepting target Guilds', () => {
  assert.match(bot, /RESET_SPAM_POLICY_COMMAND_SQL/);
  assert.match(bot, /new_preset.*DEFAULT/s);
  assert.match(bot, /guildSpamPolicyCache\.invalidate\(guildId\)/);
  assert.match(bot, /setName\("reset"\)/);
  assert.match(migration, /ADD COLUMN "changes" jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM|UPDATE "guild_spam_policy"/);
});

test('master OFF runtime gate blocks detector entry before its tracker is invoked', () => {
  const start = bot.indexOf('client.on("messageCreate"');
  const end = bot.indexOf('\nclient.on("messageUpdate"', start);
  const handler = bot.slice(start, end);
  assert.match(handler, /if \(!exclusion\.track\) \{/);
  assert.match(handler, /guildSpamDetectionTracker\.forgetUser\(message\.guild\.id, message\.author\.id\)/);
  assert.match(handler, /shouldApplyGuildSpamPolicy\([\s\S]*policy: policyContext\.policy/);
  assert.match(handler, /spamDetection = guildSpamDetectionTracker\.record/);
  assert.ok(handler.indexOf('if (!exclusion.track) {') < handler.indexOf('spamDetection = guildSpamDetectionTracker.record'));
});

test('policy migration only adds compatible fields and leaves rows unchanged', () => {
  for (const column of ['strength', 'policy_mode', 'message_burst_enabled', 'duplicate_enabled', 'mention_enabled', 'link_enabled', 'cross_channel_enabled']) assert.ok(migration.includes(`ADD COLUMN "${column}"`));
  assert.match(migration, /DEFAULT true/);
  assert.doesNotMatch(migration, /UPDATE\s+"guild_spam_policy"|DELETE\s+FROM|DROP\s+/i);
});

test('Dashboard and API use the shared policy mapping and retain Guild race guards', () => {
  assert.match(panel, /strengthToSpamPolicy|applySpamProtectionStrength/);
  assert.match(panel, /createGuildSpamPolicyRequestGuard/);
  assert.match(panel, /request\.isCurrent\(\)/);
  assert.match(route, /normalizeGuildSpamPolicy/);
  assert.match(route, /message_burst_enabled/);
  assert.match(route, /changes/);
});

test('Discord command is registered only as a guild manager command and never accepts a target Guild ID', () => {
  const start = bot.indexOf('const spamProtectionCommand = new SlashCommandBuilder()');
  const end = bot.indexOf('const dashboardCommand', start);
  assert.ok(start >= 0 && end > start);
  const definition = bot.slice(start, end);
  assert.match(definition, /setName\("spamprotection"\)/);
  assert.match(definition, /setDefaultMemberPermissions\(PermissionFlagsBits\.ManageGuild\)/);
  assert.doesNotMatch(definition, /setName\("guild_id"\)|setName\("server_id"\)/);
  assert.match(bot, /interaction\.commandName === "spamprotection"/);
  const handlerStart = bot.indexOf('async function handleSpamProtectionCommand');
  const handlerEnd = bot.indexOf('\nfunction normalizeSpamCommandPolicy', handlerStart);
  const handler = bot.slice(handlerStart, handlerEnd);
  assert.match(handler, /interaction\.inGuild\(\)/);
  assert.match(handler, /PermissionFlagsBits\.ManageGuild/);
  assert.match(handler, /PermissionFlagsBits\.Administrator/);
  assert.match(handler, /MessageFlags\.Ephemeral/);
  assert.match(handler, /guildSpamPolicyCache\.invalidate\(guildId\)/);
});
