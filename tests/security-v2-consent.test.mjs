import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveSpamPolicyAction } from '../lib/guild-spam-policy.mjs';
import { SECURITY_V2_TIMEOUT_MS } from '../lib/security-v2-consent.mjs';
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { securityV2State, readSecurityV2, mayAutomaticallyTimeout, setSecurityV2Auto } from '../lib/security-v2-consent.mjs';
import { loadSpamCommand, interaction } from './helpers/spam-command-harness.mjs';
import { incidentFixture, userId, messageId, channelId } from './helpers/timeout-incident-fixture.mjs';
const guild = '100000000000000001';
test('actual registered definition contains auto on/off/status and no reset', () => {
  const source = readFileSync(new URL('../discord-bot.mjs', import.meta.url), 'utf8');
  const definition = source.slice(source.indexOf('const spamProtectionCommand ='), source.indexOf('const dashboardCommand ='));
  const command = vm.runInNewContext(definition + '\nspamProtectionCommand', { SlashCommandBuilder, PermissionFlagsBits });
  assert.equal(command.options.some(option => option.name === 'reset'), false);
  assert.deepEqual(command.options.find(option => option.name === 'auto').options.map(option => option.name), ['on', 'off', 'status']);
  assert.ok(command.options.some(option => option.name === 'level'));
});
test('missing, partial, unavailable and emergency states cannot authorize punishment', async () => {
  for (const row of [null, {}, { migration_state: 'pending', enabled: true }, { migration_state: 'complete' },
    { migration_state: 'complete', enabled: true, emergency_stop: true }]) assert.equal(securityV2State(row).effective, false);
  assert.equal(securityV2State({ migration_state: 'complete', enabled: true, emergency_stop: false }).effective, true);
  const failure = async () => { throw new Error('DB unavailable'); };
  assert.equal((await readSecurityV2(failure, guild)).autoTimeout, false);
  assert.equal(await mayAutomaticallyTimeout(failure, guild, { emergencyStop: false }), false);
  let queries = 0;
  assert.equal(await mayAutomaticallyTimeout(async () => { queries++; }, guild), false);
  assert.equal(queries, 0);
});
test('only explicit auto on/off writes; no reset or implicit enable', async () => {
  let calls = 0;
  for (const op of ['reset', '', true, undefined]) await assert.rejects(setSecurityV2Auto(async () => { calls++; }, guild, 'actor', op));
  assert.equal(calls, 0);
});
test('Discord auto path runs actual handler and enforces Guild admin authorization', async () => {
  const calls = [];
  const h = loadSpamCommand({ query: async (q, p) => {
    calls.push(p);
    if (q.includes('WITH saved')) return { rows: [{ enabled: p[1], revision: 2 }] };
    if (q.includes('SELECT e.migration_state')) return { rows: [{ migration_state: 'complete', enabled: false, emergency_stop: true }] };
    return { rows: [] };
  } });
  const off = interaction('off'); off.options.getSubcommandGroup = () => 'auto';
  await h.run(off); assert.match(off.replies[0].content, /Auto Timeout: OFF/);
  assert.equal(calls[1][0], guild); assert.equal(calls[1][1], false);
  calls.length = 0;
  const denied = interaction('on', { permission: 'none' }); denied.options.getSubcommandGroup = () => 'auto';
  await h.run(denied); assert.equal(calls.length, 0); assert.match(denied.replies[0].content, /管理者/);
});
test('all automatic timeout entry points use v2 consent and retained reset is inert', () => {
  const bot = readFileSync(new URL('../discord-bot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bot, /LEGACY_TIMEOUT/);
  const handler = bot.slice(bot.indexOf('async function handleSpamDetection'), bot.indexOf('async function handleSpamDetection') + 9000);
  assert.equal((handler.match(/mayAutomaticallyTimeout\(/g) ?? []).length, 2);
  assert.match(handler, /SECURITY_V2_TIMEOUT_MS/);
  const route = readFileSync(new URL('../app/api/guilds/[guildId]/security/spam-policy/route.ts', import.meta.url), 'utf8');
  assert.match(route, /authorizeGuild\(request, guildId, 'guild-spam-auto-write'\)/);
  assert.match(route, /setSecurityV2Auto/);
});
test('actual detection handler: OFF, lost consent, DB failure and emergency never call Discord timeout', async () => {
  const bot = readFileSync(new URL('../discord-bot.mjs', import.meta.url), 'utf8');
  const source = bot.slice(bot.indexOf('async function handleSpamDetection'), bot.indexOf('async function replySpamComponentError'));
  for (const scenario of ['off', 'on', 'lost', 'db-error', 'emergency', 'fallback', 'sqlite']) {
    const fixture = incidentFixture();
    let queries = 0, timeouts = 0, alerts = 0;
    const member = { id: userId, displayName: 'fixture', user: {}, moderatable: true,
      timeout: async duration => { assert.equal(duration, 86_400_000); timeouts++; } };
    const context = vm.createContext({
      coordinatedSecurity: null, spamPolicyAuthority: { enabled: scenario === 'sqlite' },
      client: { user: {} }, resolveSpamPolicyAction, mayAutomaticallyTimeout, SECURITY_V2_TIMEOUT_MS,
      timeoutIncidents: fixture.incidents,
      process: { env: { SECURITY_V2_AUTO_EXECUTION: scenario === 'emergency' ? '' : 'enabled' } },
      sql: { query: async () => {
        queries++;
        if (scenario === 'db-error') throw new Error('unavailable');
        return { rows: [{ migration_state: 'complete', enabled: scenario !== 'off' && !(scenario === 'lost' && queries > 1), emergency_stop: false }] };
      } },
      randomUUID: () => 'audit', startModerationAudit: async () => 'audit', finishModerationAudit: async () => {},
      getSpamProtectedReason: () => null, moderationAuditReason: () => 'fixture',
      sendSpamDetectionAlert: async () => { alerts++; }, PermissionFlagsBits: { ModerateMembers: 1 },
      spamWindowMs: 5000, console: { error() {}, warn() {} }, Date,
    });
    const run = vm.runInContext(source + '\nhandleSpamDetection', context);
    await run({ id: messageId, createdTimestamp: fixture.input.occurredAt, author: { id: userId },
      guild: { id: guild, members: { fetch: async () => member, fetchMe: async () => ({ permissions: { has: () => true } }) } }, channelId },
      { count: 3, signals: ['messages'], policyContext: { source: scenario === 'fallback' ? 'fallback' : 'default', isCustom: false } });
    assert.equal(timeouts, scenario === 'on' ? 1 : 0, scenario);
    assert.equal(alerts, scenario === 'on' ? 1 : 0, 'timeout logs require confirmed success');
    assert.equal(fixture.incidents.snapshot(guild, fixture.begin().incidentId).detection.status, 'detected', 'detection continues while punishment OFF');
    fixture.storage.close();
  }
});
