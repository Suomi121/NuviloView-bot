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
  assert.match(i.replies[0].content, expected); assert.equal(i.replies[0].flags, 64);
  if (source === 'default') assert.match(i.replies[0].content, /legacy\/default/);
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
test('database failure returns no raw details', async () => {
  const h = loadSpamCommand({ query: async () => { throw Object.assign(new Error('private database details'), { code: '42P08' }); } });
  const i = interaction('reset'); await h.run(i);
  assert.match(i.replies[0].content, /保存できません/);
  assert.equal(JSON.stringify([...i.replies, ...h.warnings]).includes('private database details'), false);
});
