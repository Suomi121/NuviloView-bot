import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { canSendSecurityLog, readTimeoutLogChannel } from './security-log-settings.mjs';
import { timeoutFailureStatus } from './timeout-incidents.mjs';
import { evidenceComponents, securityLogFingerprint } from './security-evidence-components.mjs';

const safeId = value => typeof value === 'string' && /^\d{16,22}$/.test(value);
function safeName(value) {
  if (typeof value !== 'string' || !value.trim()) return '取得できません';
  return escapeMarkdown(value.replace(/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/@/g, '＠').replace(/</g, '‹').replace(/>/g, '›').slice(0, 100));
}
export function formatTimeoutDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('INVALID_TIMEOUT_DURATION');
  if (ms % 86400_000 === 0) return `${ms / 86400_000}日`;
  if (ms % 3600_000 === 0) return `${ms / 3600_000}時間`;
  if (ms % 60_000 === 0) return `${ms / 60_000}分`;
  return `${Math.ceil(ms / 1000)}秒`;
}
export function timeoutLogPayload(snapshot, member, confirmedChannelId = null) {
  const { detection, timeout } = snapshot;
  if (timeout?.status !== 'success' || !safeId(detection.targetId)) throw new Error('TIMEOUT_NOT_CONFIRMED');
  const seconds = Math.floor(timeout.payload.apiStartedAt / 1000);
  let description = `<t:${seconds}:F>（<t:${seconds}:R>）に\n<@${detection.targetId}> をスパム検知で${formatTimeoutDuration(timeout.payload.durationMs)}タイムアウトしたよ。`;
  if (safeId(confirmedChannelId)) description += `\nタイムアウトの通知メッセージは\n<#${confirmedChannelId}> に送信されたよ。`;
  const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('スパム検知').setDescription(description).addFields(
    { name: 'ユーザー情報', value: `ユーザー: <@${detection.targetId}>\n表示名: ${safeName(member?.displayName ?? member?.user?.globalName)}\nユーザー名: ${safeName(member?.user?.username)}\nユーザーID: ${detection.targetId}` },
    { name: '検知データ', value: `Case ID: ${detection.incidentId}\n詳細の閲覧・報告は運営権限が必要です。` },
  ).setFooter({ text: `NuviloView · Incident ${detection.incidentId}` });
  return { embeds: [embed], components: evidenceComponents(detection.incidentId), allowedMentions: { parse: [], repliedUser: false } };
}

// One durable send claim, one send, at most one edit. No retries or alternative
// destination after any failure (including an unknown network outcome).
export async function sendTimeoutIncidentLog({ incidents, query, guild, incidentId, targetMember, renderPayload = timeoutLogPayload }) {
  if (!incidents.claimLog(guild.id, incidentId)) return { status: 'not_claimed' };
  const snapshot = incidents.snapshot(guild.id, incidentId);
  let channelId = null;
  let channel;
  try {
    try { channelId = await readTimeoutLogChannel(query, guild.id); }
    catch { throw Object.assign(new Error('configuration unavailable'), { code: 'LOG_CONFIG_UNAVAILABLE' }); }
    channelId ??= snapshot.detection.payload.channelId;
    try { channel = await guild.channels.fetch(channelId, { force: true }); }
    catch { throw Object.assign(new Error('channel unavailable'), { code: 'LOG_CHANNEL_UNAVAILABLE' }); }
    if (!channel || channel.id !== channelId) throw Object.assign(new Error('channel unavailable'), { code: 'LOG_CHANNEL_UNAVAILABLE' });
    const botMember = await guild.members.fetchMe({ force: true });
    if (!canSendSecurityLog(channel, botMember, guild.id)) throw Object.assign(new Error('permission denied'), { code: 'LOG_PERMISSION_DENIED' });
  } catch (error) {
    incidents.logResult(guild.id, incidentId, 'failed', error, channelId);
    return { status: 'failed' };
  }
  let sent;
  const initialPayload = renderPayload(snapshot, targetMember);
  try {
    sent = await channel.send({ ...initialPayload,
      nonce: incidentId.slice(-24), enforceNonce: true });
  } catch (error) {
    const status = timeoutFailureStatus(error);
    incidents.logResult(guild.id, incidentId, status, error, channelId);
    return { status };
  }
  // Persist success before editing. A storage failure here deliberately leaves
  // an unresolved durable claim; redelivery must never send a duplicate.
  if (sent.channelId !== channelId || (sent.guildId && sent.guildId !== guild.id)) throw new Error('LOG_RESPONSE_MISMATCH');
  incidents.logSent(guild.id, incidentId, sent.channelId, sent.id);
  const finalPayload = renderPayload(snapshot, targetMember, sent.channelId);
  try {
    await sent.edit(finalPayload);
  } catch {
    incidents.logResult(guild.id, incidentId, 'sent_edit_failed', { code: 'LOG_EDIT_FAILED' }, null, securityLogFingerprint(initialPayload));
    return { status: 'sent_edit_failed' };
  }
  incidents.logResult(guild.id, incidentId, 'sent', null, null, securityLogFingerprint(finalPayload));
  return { status: 'sent' };
}
