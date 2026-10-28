import { PermissionFlagsBits as P, MessageFlags } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { denied } from './coordinator.mjs';
import { parseReactionRoleEmoji, getDiscordReactionEmojiKey, REACTION_ROLE_LIMIT } from '../reaction-role-utils.mjs';

const match = (r, messageId, emojiKey) => r.messageId === messageId && r.emojiKey === emojiKey;
export function createReactionRoleSettings({ store, proveOwner, allowGuild, safetyError, audit }) {
  const input = (guildId, actorId) => ({ domain: 'reaction-roles', guildId, actorId });
  async function load(guildId, actorId) {
    if (await allowGuild(guildId) !== true) denied('APP_GUILD_ACCESS_DENIED');
    return store.read(input(guildId, actorId));
  }
  async function fresh(guild, userId) {
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member?.guild?.id !== guild.id || bot?.guild?.id !== guild.id) denied('APP_REACTION_GUILD');
    return { bot, member };
  }
  async function administrator(guild, userId) {
    const { member } = await fresh(guild, userId);
    if (!member.permissions.has(P.Administrator)) denied('APP_FORBIDDEN');
  }
  return Object.freeze({ load,
    async change({ guild, actorId, requestId, expected, rule, remove = false }) {
      await administrator(guild, actorId); await proveOwner();
      const current = await load(guild.id, actorId);
      if (current.epoch !== expected.epoch || current.revision !== expected.revision || current.checksum !== expected.checksum) denied('MDB_REVISION_CONFLICT');
      const rows = current.data?.rules ?? [], rules = rows.filter(r => !match(r, rule.messageId, rule.emojiKey));
      if (!remove) {
        const { bot } = await fresh(guild, actorId);
        if (!bot.permissions.has(P.ManageRoles)) denied('APP_REACTION_PERMISSION');
        for (const id of rule.roleIds) {
          const role = guild.roles.cache.get(id);
          if (safetyError(role, guild, bot)) denied('APP_REACTION_ROLE_UNSAFE');
        }
        rules.push(rule);
      }
      await administrator(guild, actorId); await proveOwner();
      if (await allowGuild(guild.id) !== true) denied('APP_GUILD_ACCESS_DENIED');
      return store.write({ ...input(guild.id, actorId), expectedEpoch: current.epoch, expectedRevision: current.revision,
        expectedChecksum: current.checksum, acknowledgeUnconfirmed: true, requestId, data: { rules } });
    },
    async apply({ reaction, user, adding }) {
      if (user.bot || !reaction.message.guild) return { state: 'IGNORED' };
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
      const guild = reaction.message.guild, key = getDiscordReactionEmojiKey(reaction.emoji);
      const current = await load(guild.id, user.id);
      if (current.state !== 'confirmed') denied('APP_REACTION_UNCONFIRMED');
      const rule = current.data.rules.find(r => match(r, reaction.message.id, key));
      if (!rule || rule.channelId !== reaction.message.channelId) return { state: 'IGNORED' };
      const results = [];
      // One-role PUT/DELETE, never a whole-member role list replacement. These
      // Discord operations are idempotent. This function does not retry them.
      for (const roleId of rule.roleIds) {
        const { bot, member } = await fresh(guild, user.id), role = guild.roles.cache.get(roleId);
        if (!bot.permissions.has(P.ManageRoles) || safetyError(role, guild, bot)) denied('APP_REACTION_ROLE_UNSAFE');
        const before = await load(guild.id, user.id);
        if (before.epoch !== current.epoch || before.revision !== current.revision || before.checksum !== current.checksum) denied('MDB_REVISION_CONFLICT');
        await proveOwner();
        const present = member.roles.cache.has(roleId);
        if (present === adding) continue;
        const effectId = `reaction-${randomUUID()}`;
        // Durable local Audit failure blocks the external effect. Intent has
        // only IDs/revision, never raw message content or credentials.
        const entry = { effectId, guildId: guild.id, actorId: user.id, roleId, adding, revision: current.revision };
        await audit({ ...entry, state: 'DISPATCHED' });
        await proveOwner();
        const final = await load(guild.id, user.id);
        if (final.checksum !== current.checksum || final.revision !== current.revision) denied('MDB_REVISION_CONFLICT');
        try {
          const live = await fresh(guild, user.id);
          if (!live.bot.permissions.has(P.ManageRoles) || safetyError(guild.roles.cache.get(roleId), guild, live.bot)) denied('APP_REACTION_ROLE_UNSAFE');
          if (adding) await live.member.roles.add(roleId, 'NuviloView reaction role');
          else await live.member.roles.remove(roleId, 'NuviloView reaction role');
        } catch {
          await audit({ ...entry, state: 'UNKNOWN' }).catch(() => {});
          return { state: 'UNKNOWN', results };
        }
        await audit({ ...entry, state: 'CONFIRMED' }); results.push(roleId);
      }
      return { state: 'CONFIRMED', results };
    },
  });
}

export async function handleQuorumReactionRoleCommand(interaction, settings) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
  try {
    const guild = interaction.guild;
    if (!guild || guild.id !== interaction.guildId) denied('APP_REACTION_GUILD');
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    if (!actor.permissions.has(P.Administrator)) denied('APP_FORBIDDEN');
    const old = await settings.load(guild.id, actor.id), action = interaction.options.getSubcommand(true);
    const selected = interaction.options.getChannel('channel');
    if (selected && selected.guildId !== guild.id) denied('APP_REACTION_GUILD');
    if (action === 'list') {
      if (old.state !== 'confirmed') return reply('以前のリアクションロール設定は未確認です。自動付与は行いません。管理者が必要な設定を登録してください。');
      const rows = old.data.rules.filter(r => !selected || r.channelId === selected.id);
      return reply(rows.length ? `リアクションロール ${rows.length}件 · Revision ${old.revision}\n` + rows.slice(0, 25)
        .map(r => `<#${r.channelId}> / ${r.messageId} / ${r.emojiDisplay} → ${r.roleIds.map(id => `<@&${id}>`).join(' ')}`).join('\n').slice(0, 1700) : 'リアクションロール設定はありません。');
    }
    if (!['add','set','remove'].includes(action)) denied('APP_INPUT');
    const messageId = interaction.options.getString('message_id', true).trim();
    const emoji = parseReactionRoleEmoji(interaction.options.getString('emoji', true));
    if (!/^\d{16,22}$/.test(messageId) || !emoji || !selected) denied('APP_INPUT');
    const channel = await guild.channels.fetch(selected.id, { force: true });
    if (channel?.guildId !== guild.id || !channel.messages) denied('APP_REACTION_GUILD');
    const bot = await guild.members.fetchMe({ force: true });
    if (!channel.permissionsFor(bot)?.has([P.ViewChannel, P.ReadMessageHistory, P.AddReactions])) denied('APP_REACTION_PERMISSION');
    const roles = [];
    for (let i = 1; i <= REACTION_ROLE_LIMIT; i++) {
      const role = interaction.options.getRole(`role_${i}`);
      if (role && !roles.includes(role.id)) roles.push(role.id);
    }
    const rule = { channelId: channel.id, messageId, emojiKey: emoji.key, emojiDisplay: emoji.display, roleIds: roles };
    if (action !== 'remove') await channel.messages.fetch(messageId);
    const saved = await settings.change({ guild, actorId: actor.id, requestId: interaction.id, expected: old, rule, remove: action === 'remove' });
    // Saving policy does not require adding a decorative reaction. A failed
    // react must never be confused with a failed policy commit or retried save.
    return reply(`リアクションロール設定を${action === 'remove' ? '削除' : '保存'}しました。Revision ${saved.revision}。すでに付与済みのロールは変更しません。`);
  } catch (error) {
    return reply(error?.code === 'APP_FORBIDDEN' ? 'この操作はサーバーの管理者のみ利用できます。' :
      '設定・権限・DB合意を確認できません。保存結果を再読込してください。以前のキャッシュは使用しません。');
  }
}
