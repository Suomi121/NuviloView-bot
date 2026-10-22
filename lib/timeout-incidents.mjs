import { createHash } from 'node:crypto';

const snowflake = value => typeof value === 'string' && /^\d{16,22}$/.test(value);
export const DETECTION_RULES = Object.freeze({ messages: '短時間の連続投稿', duplicates: '同一内容の繰り返し',
  mentions: 'メンション数', links: 'リンク数', cross_channel: '複数チャンネルへの投稿' });
const stages = new Set(['timeout_claim', 'timeout_api', 'timeout_result', 'log_claim', 'log_sent', 'log_result']);
const safeCodes = new Set(['TIMEOUT_DENIED', 'TARGET_PROTECTED', 'TARGET_UNAVAILABLE', 'ALREADY_TIMEOUT',
  'DISCORD_API_ERROR', 'DISCORD_RATE_LIMIT', 'DISCORD_UNAVAILABLE', 'DISCORD_FORBIDDEN', 'DISCORD_NOT_FOUND',
  'LOG_CONFIG_UNAVAILABLE', 'LOG_CHANNEL_UNAVAILABLE', 'LOG_PERMISSION_DENIED', 'LOG_EDIT_FAILED', 'LOG_SEND_FAILED']);
export function safeIncidentError(error) {
  if (error?.status === 403 || error?.code === 50013 || error?.code === 50001) return 'DISCORD_FORBIDDEN';
  if (error?.status === 404 || error?.code === 10003) return 'DISCORD_NOT_FOUND';
  if (error?.status === 429) return 'DISCORD_RATE_LIMIT';
  if (error?.status >= 500) return 'DISCORD_UNAVAILABLE';
  return safeCodes.has(error?.code) ? error.code : 'DISCORD_API_ERROR';
}
export function timeoutFailureStatus(error) {
  // A rejected 4xx call is different from a lost response / server error.
  // Unknown outcomes must never be retried automatically.
  return error?.status >= 400 && error?.status < 500 ? 'failed' : 'unknown';
}
export function timeoutIncidentId(guildId, userId, messageId) {
  if (![guildId, userId, messageId].every(snowflake)) throw new Error('INCIDENT_INVALID_ID');
  return `timeout-${createHash('sha256').update(`${guildId}:${userId}:${messageId}`).digest('hex').slice(0, 40)}`;
}

// All stages are immutable security Audit events replicated by the existing
// Outbox. External Discord actions are NOT put on a replayable sync queue.
export function createTimeoutIncidentService({ audit, now = () => Date.now(), version = 'UNKNOWN', commit = null }) {
  const read = eventId => audit.getModerationAudit(eventId);
  function incident(guildId, incidentId) {
    const row = read(incidentId);
    if (!row || row.guildId !== guildId || row.action !== 'spam_detection') throw new Error('INCIDENT_NOT_FOUND');
    return row;
  }
  function stage(guildId, incidentId, name, status, payload = {}) {
    if (!stages.has(name)) throw new Error('INCIDENT_INVALID_STAGE');
    const parent = incident(guildId, incidentId);
    return audit.recordIncidentEvent({ eventId: `${incidentId}:${name}`, guildId, incidentId,
      targetId: parent.targetId, category: 'moderation', severity: ['timeout_api', 'timeout_result'].includes(name) ? 'high' : 'medium', action: name, status,
      occurredAt: now(), payload });
  }
  function begin({ guildId, userId, messageId, channelId, occurredAt, signals, count, windowSeconds }) {
    if (!snowflake(channelId)) throw new Error('INCIDENT_INVALID_CHANNEL');
    const at = Number(occurredAt);
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error('INCIDENT_INVALID_TIME');
    const rules = [...new Set((signals ?? []).filter(value => Object.hasOwn(DETECTION_RULES, value)))];
    const id = timeoutIncidentId(guildId, userId, messageId);
    return audit.recordIncidentEvent({ eventId: id, guildId, incidentId: id, targetId: userId,
      category: 'moderation', severity: 'medium', action: 'spam_detection', status: 'detected', occurredAt: at,
      payload: { channelId, rules, reason: rules.map(value => DETECTION_RULES[value]).join('・'),
        count: Number.isSafeInteger(count) && count >= 0 ? count : null,
        windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? Math.min(windowSeconds, 86400) : null,
        botVersion: /^[\w.+-]{1,64}$/.test(version) ? version : 'UNKNOWN',
        botCommit: /^[a-f\d]{7,40}$/i.test(commit ?? '') ? commit : 'UNKNOWN' } });
  }
  return Object.freeze({ begin, incident,
    snapshot(guildId, id) {
      const detection = incident(guildId, id);
      const timeout = read(`${id}:timeout_result`), timeoutAttempt = read(`${id}:timeout_api`);
      const log = read(`${id}:log_result`), sent = read(`${id}:log_sent`), logClaim = read(`${id}:log_claim`);
      return { detection, timeout, timeoutAttempt, log, sent, logClaim,
        timeoutState: timeout?.status ?? (timeoutAttempt ? 'pending_or_unknown' : 'not_attempted'),
        logState: log?.status ?? (sent ? 'sent_confirmation_pending' : logClaim ? 'pending_or_unknown' : 'not_attempted') };
    },
    claimTimeout: (guildId, id) => !read(`${id}:timeout_result`) && stage(guildId, id, 'timeout_claim', 'pending').inserted,
    timeoutApi(guildId, id, durationMs) {
      if (!read(`${id}:timeout_claim`) || read(`${id}:timeout_result`)) throw new Error('INCIDENT_NOT_CLAIMED');
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 28 * 86400_000) throw new Error('INCIDENT_INVALID_DURATION');
      const at = now();
      return stage(guildId, id, 'timeout_api', 'pending', { apiStartedAt: at, durationMs, scheduledEndAt: at + durationMs });
    },
    timeoutResult(guildId, id, status, error = null, actualEndAt = null) {
      if (!['success', 'failed', 'skipped', 'unknown'].includes(status)) throw new Error('INCIDENT_INVALID_STATUS');
      const attempt = read(`${id}:timeout_api`);
      if (status === 'success' && !attempt) throw new Error('INCIDENT_NO_TIMEOUT_ATTEMPT');
      return stage(guildId, id, 'timeout_result', status, { apiStartedAt: attempt?.payload.apiStartedAt ?? null,
        durationMs: attempt?.payload.durationMs ?? null, scheduledEndAt: attempt?.payload.scheduledEndAt ?? null,
        actualEndAt: status === 'success' && Number.isSafeInteger(actualEndAt) ? actualEndAt : null,
        completedAt: now(), errorCode: error ? safeIncidentError(error) : null });
    },
    claimLog(guildId, id) {
      if (read(`${id}:timeout_result`)?.status !== 'success') return false;
      return stage(guildId, id, 'log_claim', 'pending').inserted;
    },
    logSent(guildId, id, channelId, messageId) {
      if (!read(`${id}:log_claim`)) throw new Error('INCIDENT_NOT_CLAIMED');
      if (![channelId, messageId].every(snowflake)) throw new Error('INCIDENT_INVALID_DELIVERY');
      return stage(guildId, id, 'log_sent', 'sent', { channelId, messageId });
    },
    logResult(guildId, id, status, error = null, channelId = null, fingerprint = null) {
      if (!['sent', 'failed', 'unknown', 'sent_edit_failed'].includes(status)) throw new Error('INCIDENT_INVALID_LOG_STATUS');
      const sent = read(`${id}:log_sent`);
      if (['sent', 'sent_edit_failed'].includes(status) && !sent) throw new Error('INCIDENT_NO_DELIVERY');
      return stage(guildId, id, 'log_result', status, { channelId: sent?.payload.channelId ?? (snowflake(channelId) ? channelId : null),
        messageId: sent?.payload.messageId ?? null, errorCode: error ? safeIncidentError(error) : null,
        fingerprint: /^[a-f0-9]{64}$/.test(fingerprint ?? '') ? fingerprint : null });
    },
  });
}
