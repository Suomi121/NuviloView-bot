import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { createInteractionLimiter, freshSecurityMember } from './security-operators.mjs';

const rows = result => Array.isArray(result) ? result : result?.rows ?? [];
const validId = value => typeof value === 'string' && /^\d{16,22}$/.test(value);
export const timeoutLogCommand = new SlashCommandBuilder().setName('tosetlog')
  .setDescription('タイムアウトログの通知先を管理します').setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub.setName('set').setDescription('専用ログチャンネルを設定します')
    .addChannelOption(option => option.setName('channel').setDescription('通知先').setRequired(true)
      .addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(sub => sub.setName('off').setDescription('専用通知先を解除し、検知したチャンネルを使います'))
  .addSubcommand(sub => sub.setName('status').setDescription('現在の通知先を確認します')).toJSON();

export const SET_TIMEOUT_LOG_SQL = `
 WITH saved AS (
   INSERT INTO guild_security_log (guild_id, channel_id, updated_by)
   VALUES ($1::text, $2::text, $3::text)
   ON CONFLICT (guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,
     updated_by=EXCLUDED.updated_by, revision=guild_security_log.revision+1, updated_at=now()
   RETURNING guild_id, channel_id, revision
 ), audited AS (
   INSERT INTO guild_security_log_audit (guild_id, channel_id, actor_id, revision)
   SELECT guild_id, channel_id, $3::text, revision FROM saved RETURNING id
 ) SELECT channel_id FROM saved CROSS JOIN audited`;

export async function readTimeoutLogChannel(query, guildId) {
  if (!validId(guildId)) throw new Error('INVALID_GUILD');
  const row = rows(await query('SELECT channel_id FROM guild_security_log WHERE guild_id=$1::text', [guildId]))[0];
  if (!row || row.channel_id === null) return null;
  if (!validId(row.channel_id)) throw new Error('INVALID_LOG_SETTING');
  return row.channel_id;
}

export function canSendSecurityLog(channel, botMember, guildId) {
  if (!channel || channel.guildId !== guildId || !channel.isTextBased?.() || typeof channel.send !== 'function') return false;
  // Threads need SendMessagesInThreads, not SendMessages. Archived/locked threads
  // are never automatically reopened for a log.
  if (channel.isThread?.() && (channel.archived || channel.locked)) return false;
  const permissions = channel.permissionsFor(botMember);
  return Boolean(permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages]));
}

export function createTimeoutLogCommandHandler({ query, allow = createInteractionLimiter() }) {
  return async interaction => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    try {
      if (!allow(`${interaction.guildId}:${interaction.user.id}`)) return await reply('少し待ってからもう一度試してね。');
      const { guild, member, administrator } = await freshSecurityMember(interaction);
      if (!administrator) return await reply('通知先を設定・確認できるのはサーバー所有者かAdministratorだけだよ。');
      const operation = interaction.options.getSubcommand();
      if (operation === 'status') {
        const channelId = await readTimeoutLogChannel(query, guild.id);
        return await reply(channelId
          ? `専用ログ通知先: <#${channelId}>\n送信できない場合も、別チャンネルには転送しません。内部Auditは保持します。`
          : '専用ログ通知先: 未設定\nタイムアウトに成功したとき、スパムを検知したチャンネルへログを1回送信します。');
      }
      if (!['set', 'off'].includes(operation)) return await reply('その操作は利用できません。');
      let channelId = null;
      if (operation === 'set') {
        const selected = interaction.options.getChannel('channel', true);
        if (!validId(selected.id)) return await reply('このサーバーのテキストチャンネルを選んでね。');
        const channel = await guild.channels.fetch(selected.id, { force: true });
        const bot = await guild.members.fetchMe({ force: true });
        if (channel?.id !== selected.id || channel?.type !== ChannelType.GuildText || !canSendSecurityLog(channel, bot, guild.id)
          || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
          return await reply('このサーバー内で、Botが閲覧・送信・Embed表示できるテキストチャンネルを選んでね。');
        }
        channelId = channel.id;
      }
      const result = rows(await query(SET_TIMEOUT_LOG_SQL, [guild.id, channelId, member.id]));
      if (result.length !== 1 || result[0].channel_id !== channelId) throw new Error('SAVE_FAILED');
      return await reply(channelId ? `ログの送信先を <#${channelId}> に設定したよ！`
        : '専用ログチャンネルの設定を解除したよ！\nこれからはスパムを検知したチャンネルにログを送信するよ。');
    } catch {
      return await reply('通知先を確認・保存できませんでした。少し待ってから再確認してね。');
    }
  };
}
