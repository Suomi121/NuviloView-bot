import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GUILD_SPAM_POLICY, applySpamProtectionStrength } from '../lib/guild-spam-policy.mjs';
import { loadSpamCommand, interaction } from './helpers/spam-command-harness.mjs';

for (const [label, policy, source, expected] of [
  ['default', null, 'default', /NORMAL.*50\/100/s],
  ['saved', applySpamProtectionStrength(DEFAULT_GUILD_SPAM_POLICY, 75), 'guild', /STRICT.*75\/100/s],
  ['custom', { ...DEFAULT_GUILD_SPAM_POLICY, mode: 'CUSTOM' }, 'guild', /Custom/],
]) test(`actual status handler: ${label}`, async () => {
  const h = loadSpamCommand({ get: async () => ({ source, policy }) });
  const i = interaction(); await h.run(i);
  assert.equal(h.warnings.length, 0); assert.equal(i.replies.length, 1);
  assert.match(i.replies[0].content, expected);
  assert.equal(i.acknowledgements.length, 1); assert.equal(i.acknowledgements[0].flags, 64);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
  if (source === 'default') {
    assert.match(i.replies[0].content, /Default detection; Auto Timeout requires explicit consent/);
    assert.doesNotMatch(i.replies[0].content, /legacy\/default/);
  }
});

for (const operation of ['status', 'level', 'reset']) test(`${operation}: non-manager denied before reads or writes`, async () => {
  const h = loadSpamCommand({ get: async () => { throw new Error('Forbidden read'); } });
  const i = interaction(operation, { permission: 'none' }); await h.run(i);
  assert.match(i.replies[0].content, /管理者/); assert.equal(h.invalidated.length, 0);
  assert.equal(h.warnings.length, 0);
});
test('DM rejected before database access', async () => {
  const h = loadSpamCommand(); const i = interaction('reset', { inGuild: false });
  await h.run(i); assert.match(i.replies[0].content, /サーバー内/);
});
test('retired reset performs no SQL or cache access', async () => {
  const h = loadSpamCommand({ query: async () => { throw Object.assign(new Error('private database details'), { code: '42P08' }); } });
  const i = interaction('reset'); await h.run(i);
  assert.match(i.replies[0].content, /SPAM_RESET_RETIRED/);
  assert.equal(h.warnings.length, 0); assert.equal(h.invalidated.length, 0);
  assert.equal(JSON.stringify([...i.replies, ...h.warnings]).includes('private database details'), false);
});

test('status acknowledges before both delayed reads, avoiding the 10062 deadline', async () => {
  // Virtual Discord deadline: DB reads take 3.4 seconds, not wall-clock sleeps.
  let elapsed = 0, acknowledgedAt = null; const events = [];
  const i = interaction(); const defer = i.deferReply.bind(i), reply = i.reply.bind(i);
  i.deferReply = async payload => { acknowledgedAt = elapsed; events.push('ack'); await defer(payload); };
  i.reply = async payload => {
    if (elapsed >= 3000 && acknowledgedAt === null) throw Object.assign(new Error('Expired'), { code: 10062 });
    return reply(payload);
  };
  const h = loadSpamCommand({
    get: async guild => {
      assert.equal(i.deferred, true); assert.equal(guild, i.guildId);
      events.push('policy'); elapsed += 1700; return { source: 'default', policy: null };
    },
    query: async (sql, values) => {
      assert.equal(i.deferred, true); assert.deepEqual(values.map(String), [i.guildId]);
      assert.match(sql, /SELECT/); events.push('consent'); elapsed += 1700;
      return { rows: [{ migration_state: 'complete', enabled: false, emergency_stop: false }] };
    },
  });
  await h.run(i);
  assert.equal(elapsed, 3400); assert.equal(acknowledgedAt, 0);
  assert.deepEqual(events, ['ack', 'policy', 'consent']);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
  assert.equal(h.warnings.length, 0); assert.match(i.replies[0].content, /Migration: complete/);
});

test('status defers while a database promise remains unresolved', async () => {
  let finishRead; const pendingRead = new Promise(resolve => { finishRead = resolve; });
  let reading = false;
  const h = loadSpamCommand({ get: async () => { reading = true; await pendingRead; return { source: 'default', policy: null }; } });
  const i = interaction(); const running = h.run(i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(i.deferred, true); assert.equal(reading, true); assert.equal(i.replies.length, 0);
  finishRead(); await running;
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
});

test('policy DB failure edits the deferred response without leaking details', async () => {
  const h = loadSpamCommand({ get: async () => { throw Object.assign(new Error('private database details'), { code: 'ECONNRESET' }); } });
  const i = interaction(); await h.run(i);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
  assert.match(i.replies[0].content, /設定を保存できませんでした/);
  assert.equal(JSON.stringify([...i.replies, ...h.warnings]).includes('private database details'), false);
});

test('consent DB failure retains fail-closed status after deferral', async () => {
  const h = loadSpamCommand({ query: async () => { throw new Error('private database details'); } });
  const i = interaction(); await h.run(i);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
  assert.match(i.replies[0].content, /Auto Timeout: OFF/);
  assert.match(i.replies[0].content, /Migration: unavailable/);
  assert.equal(JSON.stringify(i.replies).includes('private database details'), false);
});

for (const initialState of ['deferred', 'replied']) test(`status reuses an already ${initialState} interaction`, async () => {
  const i = interaction(); i[initialState] = true;
  const h = loadSpamCommand(); await h.run(i);
  assert.deepEqual(i.responseMethods, ['edit']); assert.equal(i.acknowledgements.length, 0);
  assert.equal(h.warnings.length, 0);
});

for (const code of [10062, 40060, 'ECONNRESET']) test(`failed status acknowledgement ${code} does not retry or read the DB`, async () => {
  let attempts = 0, reads = 0;
  const h = loadSpamCommand({ get: async () => { reads++; throw new Error('Must not read'); } });
  const i = interaction();
  i.deferReply = async () => { attempts++; throw Object.assign(new Error('private response details'), { code }); };
  await h.run(i);
  assert.equal(attempts, 1); assert.equal(reads, 0); assert.equal(h.invalidated.length, 0);
  assert.deepEqual(i.responseMethods, []); assert.equal(i.replies.length, 0);
  assert.equal(JSON.stringify(h.warnings).includes('private response details'), false);
});

for (const code of [10062, 40060]) test(`expired or duplicate edit ${code} never falls back to another initial reply`, async () => {
  const i = interaction(); let edits = 0;
  i.editReply = async () => { edits++; throw Object.assign(new Error('private response details'), { code }); };
  const h = loadSpamCommand(); await h.run(i);
  assert.equal(edits, 1); assert.deepEqual(i.responseMethods, ['defer']); assert.equal(i.replies.length, 0);
});

for (const permission of ['admin', 'manage']) test(`status preserves ${permission} authorization and Guild query scoping`, async () => {
  const guild = '100000000000000099'; const reads = [];
  const h = loadSpamCommand({ get: async id => { reads.push(id); return { source: 'guild', policy: DEFAULT_GUILD_SPAM_POLICY }; },
    query: async (sql, values) => { reads.push(...values); return { rows: [] }; } });
  const i = interaction('status', { guild, permission }); await h.run(i);
  assert.deepEqual(reads, [guild, guild]); assert.deepEqual(i.responseMethods, ['defer', 'edit']);
});

test('non-manager status is rejected without deferring or accessing Guild data', async () => {
  const h = loadSpamCommand({ get: async () => { throw new Error('Must not read'); } });
  const i = interaction('status', { permission: 'none' }); await h.run(i);
  assert.deepEqual(i.responseMethods, ['reply']); assert.equal(i.acknowledgements.length, 0);
  assert.equal(h.invalidated.length, 0); assert.match(i.replies[0].content, /管理者/);
});

test('auto status keeps its existing defer/edit path without policy reads', async () => {
  const h = loadSpamCommand({ get: async () => { throw new Error('Must not read detection policy'); },
    query: async () => ({ rows: [{ migration_state: 'complete', enabled: false, emergency_stop: false }] }) });
  const i = interaction('status'); i.options.getSubcommandGroup = () => 'auto';
  await h.run(i);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']); assert.equal(h.invalidated.length, 0);
  assert.match(i.replies[0].content, /Auto Timeout: OFF/); assert.equal(h.warnings.length, 0);
});
