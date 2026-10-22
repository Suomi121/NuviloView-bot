import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { authorizeSecurityOperator, createInteractionLimiter, readOperatorRoles } from './security-operators.mjs';
import { createFalsePositiveReports, evidenceText, securityId, validateEvidenceSnapshot } from './security-evidence.mjs';
import { parseEvidenceAction, securityLogFingerprint } from './security-evidence-components.mjs';
import { createSecurityReportDelivery } from './security-report-delivery.mjs';

export function reportReceiverConfig(env) {
  const guildId = env.SECURITY_REPORT_GUILD_ID?.trim(), channelId = env.SECURITY_REPORT_CHANNEL_ID?.trim();
  const roleIds = (env.SECURITY_REPORT_RECEIVER_ROLE_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (![guildId, channelId].every(securityId) || roleIds.length > 10 || roleIds.some(v => !securityId(v))) return null;
  return { guildId, channelId, roleIds: [...new Set(roleIds)] };
}

// Explicit private receiver, never an inferred developer Guild / public fallback.
// @everyone must be denied ViewChannel and all other ViewChannel grants must be
// trusted developer roles (configured out-of-band), owner or this Bot. Global
// Administrator bypasses channel denies, so unapproved admin roles also deny delivery.
export async function privateReportChannel(client, receiver) {
  const guild = await client.guilds.fetch({ guild: receiver.guildId, force: true });
  if (guild.id !== receiver.guildId) throw new Error('RECEIVER_MISMATCH');
  const roles = await guild.roles.fetch();
  if (!roles || typeof roles.get !== 'function') throw new Error('RECEIVER_ROLES_UNAVAILABLE');
  for (const id of receiver.roleIds) {
    const role = roles.get(id);
    if (!role || id === guild.id || role.managed || role.tags) throw new Error('RECEIVER_ROLE_INVALID');
  }
  const channel = await guild.channels.fetch(receiver.channelId, { force: true });
  if (!channel || channel.id !== receiver.channelId || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) throw new Error('RECEIVER_UNAVAILABLE');
  const bot = await guild.members.fetchMe({ force: true });
  if (bot.id !== client.user.id || !channel.permissionsFor(bot)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles,
  ])) throw new Error('RECEIVER_PERMISSION_DENIED');
  for (const role of roles.values()) {
    const ownBotRole = role.tags?.botId === client.user.id && bot.roles?.cache.has(role.id);
    if (role.permissions.has(PermissionFlagsBits.Administrator) && !ownBotRole
      && !receiver.roleIds.includes(role.id)) throw new Error('RECEIVER_UNAPPROVED_ADMIN');
  }
  const overwrites = channel.permissionOverwrites?.cache;
  if (!overwrites || overwrites.size > 50 || !overwrites.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel)) throw new Error('RECEIVER_NOT_PRIVATE');
  for (const overwrite of overwrites.values()) {
    if (!overwrite.allow.has(PermissionFlagsBits.ViewChannel)) continue;
    if (overwrite.id === guild.id) throw new Error('RECEIVER_NOT_PRIVATE');
    if (overwrite.type === 1 && [bot.id, guild.ownerId].includes(overwrite.id)) continue;
    const role = roles.get(overwrite.id);
    if (overwrite.type === 0 && role?.tags?.botId === client.user.id && bot.roles?.cache.has(role.id)) continue;
    if (overwrite.type !== 0 || !role || role.managed || role.tags
      || !receiver.roleIds.includes(role.id)) throw new Error('RECEIVER_NOT_PRIVATE');
  }
  return channel;
}

async function boundSource(interaction, current, snapshot, client) {
  const { sent, log } = snapshot;
  if (snapshot.timeout?.status !== 'success' || !['sent', 'sent_edit_failed'].includes(log?.status) || !log.payload.fingerprint
    || sent?.payload?.messageId !== interaction.message?.id
    || sent?.payload?.channelId !== interaction.channelId
    || interaction.message.author?.id !== client.user?.id) throw new Error('SOURCE_MISMATCH');
  const channel = await current.guild.channels.fetch(interaction.channelId, { force: true });
  if (!channel || channel.guildId !== current.guild.id || channel.id !== interaction.channelId
    || !channel.permissionsFor(current.member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('SOURCE_DENIED');
  const message = await channel.messages.fetch({ message: sent.payload.messageId, force: true, cache: false });
  if (!message || message.id !== sent.payload.messageId || message.guildId !== current.guild.id
    || message.channelId !== channel.id || message.author?.id !== client.user.id
    || message.attachments?.size !== 0 || message.content
    || securityLogFingerprint(message) !== log.payload.fingerprint) throw new Error('SOURCE_MISMATCH');
  const buttons = message.components.flatMap(row => row.components);
  if (!buttons.some(b => (b.customId ?? b.custom_id) === interaction.customId)) throw new Error('SOURCE_MISMATCH');
}

export function createSecurityEvidenceHandler({ incidents, audit, query, client, receiver = null,
  now = () => Date.now(), allow = createInteractionLimiter(), maxConcurrent = 4,
  sendReport = createSecurityReportDelivery({ client }) }) {
  const reports = audit ? createFalsePositiveReports({ audit, now }) : null;
  let active = 0;
  return async interaction => {
    // No DB, role fetch, source-message fetch or receiver lookup before ACK.
    // An expired/replied interaction must not be retried via reply().
    if (interaction.deferred || interaction.replied) return;
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); }
    catch { return; }
    const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    if (active >= maxConcurrent || !allow(`${interaction.guildId}:${interaction.user.id}`)) {
      await reply('少し待ってからもう一度試してね。').catch(() => {}); return;
    }
    active++;
    try {
      const parsed = parseEvidenceAction(interaction.customId);
      if (!parsed || !incidents || !reports) throw new Error('EVIDENCE_UNAVAILABLE');
      const current = await authorizeSecurityOperator(interaction, query);
      if (!current) return await reply('検知データの閲覧・報告には、このサーバーの運営権限が必要だよ。');
      // Also validate DB availability for Owner/Admin and re-check delegated
      // roles against the latest DB result; privileged settings remain separate.
      const roles = await readOperatorRoles(query, current.guild.id);
      if (!current.administrator && !roles.some(id => id !== current.guild.id
        && current.roles.has(id) && !current.roles.get(id).managed
        && !current.roles.get(id).tags && current.member.roles.cache.has(id))) throw new Error('OPERATOR_REVOKED');
      const snapshot = validateEvidenceSnapshot(incidents.snapshot(current.guild.id, parsed.incidentId), current.guild.id, parsed.incidentId, now());
      await boundSource(interaction, current, snapshot, client);
      if (parsed.action === 'e') {
        const attachment = evidenceText(snapshot);
        reports.viewed(current.guild.id, parsed.incidentId, current.member.id);
        const seconds = Math.floor(snapshot.detection.occurredAt / 1000);
        return await interaction.editReply({ content: `NuviloView 検知データ\nCase ID: ${parsed.incidentId}\n検知日時: <t:${seconds}:F>（<t:${seconds}:R>）`,
          files: [{ attachment, name: `nuviloview-evidence-${parsed.incidentId}.txt` }], allowedMentions: { parse: [] } });
      }
      const existing = reports.state(current.guild.id, parsed.incidentId);
      if (existing.status !== 'NOT_REPORTED') return await reply(`このケースの報告は受付済みだよ。\nReport ID: ${existing.reportId}\n状態: ${existing.status}\n自動再送はしません。`);
      if (!receiver) return await reply('開発者への送信先が設定されていないよ。');
      const destination = await privateReportChannel(client, receiver);
      const attachment = evidenceText(snapshot, { reportId: existing.reportId, reporterId: current.member.id, reportedAt: now() });
      if (!reports.claim(current.guild.id, parsed.incidentId, current.member.id, receiver)
        || !reports.sending(current.guild.id, parsed.incidentId, current.member.id)) return await reply('このケースは既に受付中だよ。自動再送はしません。');
      let sent;
      try {
        sent = await sendReport(destination, { content: `NuviloView · 誤検知の疑いがある報告\nReport ID: ${existing.reportId}`,
          files: [{ attachment, name: `nuviloview-false-positive-${existing.reportId}.txt` }],
          allowedMentions: { parse: [] }, nonce: existing.reportId.slice(-24), enforceNonce: true });
      } catch (error) {
        const result = error?.status >= 400 && error?.status < 500 ? 'FAILED' : 'UNKNOWN';
        reports.result(current.guild.id, parsed.incidentId, current.member.id, result, error);
        return await reply(`報告の送信を確認できませんでした。\nReport ID: ${existing.reportId}\n状態: ${result}\n重複を防ぐため自動再送はしません。`);
      }
      // If Discord succeeded but persistence failed, a durable SENDING/claim
      // remains. Never turn that uncertainty into a fresh send on next click.
      if (!securityId(sent?.id) || sent.channelId !== receiver.channelId || sent.guildId !== receiver.guildId) throw new Error('DELIVERY_MISMATCH');
      reports.sent(current.guild.id, parsed.incidentId, current.member.id, sent.id);
      reports.result(current.guild.id, parsed.incidentId, current.member.id, 'SENT');
      return await reply(`誤検知の疑いがある報告を送信したよ！\nReport ID: ${existing.reportId}\n誤検知の確定やタイムアウト解除は行っていません。`);
    } catch {
      await reply('権限・保存済みデータ・送信先を確認できませんでした。成功扱いにはしていません。自動再送はしません。').catch(() => {});
    } finally { active--; }
  };
}
