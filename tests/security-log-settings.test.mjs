import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createTimeoutLogCommandHandler, readTimeoutLogChannel, timeoutLogCommand } from '../lib/security-log-settings.mjs';
import { operatorFixture, guildId } from './helpers/security-operator-fixture.mjs';
const channelId = '400000000000000001';
function fixture(kind, operation = 'set', change = () => {}) {
  const f = operatorFixture({ kind });
  const channel = { id: channelId, guildId, type: ChannelType.GuildText, isTextBased: () => true, send: async () => {},
    permissionsFor: () => ({ has: () => true }) };
  f.interaction.options.getSubcommand = () => operation;
  f.interaction.options.getChannel = () => ({ id: channelId });
  f.guild.channels = { fetch: async () => channel };
  change(f, channel);
  return f;
}
for (const kind of ['owner', 'admin', 'operator', 'manage', 'member']) {
  for (const operation of ['set', 'off', 'status']) test(`tosetlog ${operation}: ${kind}`, async () => {
    const f = fixture(kind, operation); const calls = [];
    await createTimeoutLogCommandHandler({ query: async (q, p) => {
      calls.push([q, p]); return { rows: [{ channel_id: operation === 'off' ? null : channelId }] };
    } })(f.interaction);
    assert.equal(calls.length, ['owner', 'admin'].includes(kind) ? 1 : 0);
    if (calls.length) assert.equal(calls[0][1][0], guildId);
    if (operation === 'off' && calls.length) {
      assert.equal(calls[0][1][1], null); assert.match(f.replies[0].content, /検知したチャンネル/);
    }
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
  });
}
test('foreign/deleted/unviewable/unsendable channels cannot be saved', async () => {
  for (const change of [(_f,c) => { c.guildId = 'other'; }, (_f,c) => { c.type = ChannelType.GuildVoice; },
    (f) => { f.guild.channels.fetch = async () => null; }, (_f,c) => { c.permissionsFor = () => null; },
    (_f,c) => { c.permissionsFor = () => ({ has: p => !Array.isArray(p) || !p.includes(PermissionFlagsBits.EmbedLinks) }); }]) {
    const f = fixture('admin', 'set', change); let writes = 0;
    await createTimeoutLogCommandHandler({ query: async () => { writes++; } })(f.interaction);
    assert.equal(writes, 0); assert.doesNotMatch(f.replies[0].content, /設定したよ/);
  }
});
test('storage failures and malformed metadata never become success or fallback', async () => {
  const f = fixture('owner');
  await createTimeoutLogCommandHandler({ query: async () => { throw new Error('secret fixture'); } })(f.interaction);
  assert.doesNotMatch(f.replies[0].content, /secret|設定したよ/);
  await assert.rejects(readTimeoutLogChannel(async () => ({ rows: [{ channel_id: 'bad' }] }), guildId));
  assert.equal(await readTimeoutLogChannel(async () => ({ rows: [] }), guildId), null);
  assert.deepEqual(timeoutLogCommand.options.map(o => o.name), ['set','off','status']);
});
