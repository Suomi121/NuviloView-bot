import { createHash } from 'node:crypto';
import { DETECTION_RULES, safeIncidentError } from './timeout-incidents.mjs';
import { incidentIdPattern } from './security-evidence-components.mjs';

export const EVIDENCE_TTL_MS = 90 * 86400_000;
export const EVIDENCE_MAX_BYTES = 16 * 1024;
export const securityId = value => typeof value === 'string' && /^\d{16,22}$/.test(value);
const id = value => securityId(value) ? value : 'UNKNOWN';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 'UNKNOWN';
const time = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : 'UNKNOWN';
const status = (value, allowed) => allowed.includes(value) ? value.toUpperCase() : 'UNKNOWN';

export function reportIdFor(guildId, incidentId) {
  if (!securityId(guildId) || !incidentIdPattern.test(incidentId)) throw new Error('INVALID_REPORT');
  return `NV-FP-${createHash('sha256').update(`${guildId}:${incidentId}`).digest('hex').slice(0, 40)}`;
}
export function validateEvidenceSnapshot(snapshot, guildId, incidentId, now = Date.now()) {
  const detection = snapshot?.detection;
  if (!detection || detection.guildId !== guildId || detection.incidentId !== incidentId
    || detection.eventId !== incidentId || detection.action !== 'spam_detection'
    || !incidentIdPattern.test(incidentId) || !securityId(detection.targetId)
    || !Number.isSafeInteger(detection.occurredAt) || detection.occurredAt > now
    || now - detection.occurredAt > EVIDENCE_TTL_MS) throw new Error('EVIDENCE_UNAVAILABLE');
  for (const [key, suffix] of Object.entries({ timeout: 'timeout_result', timeoutAttempt: 'timeout_api',
    log: 'log_result', sent: 'log_sent', logClaim: 'log_claim' })) {
    const row = snapshot[key];
    if (row && (row.guildId !== guildId || row.incidentId !== incidentId || row.eventId !== `${incidentId}:${suffix}`
      || row.action !== suffix || row.targetId !== detection.targetId)) throw new Error('EVIDENCE_MISMATCH');
  }
  return snapshot;
}

// Never spread stored payloads into output. Historic evidence is projected from
// a small typed allow-list; current policy, raw reason/error and names are not read.
export function safeEvidence(snapshot) {
  const d = snapshot.detection, p = d.payload ?? {}, t = snapshot.timeout?.payload ?? {};
  const rules = Array.isArray(p.rules) ? [...new Set(p.rules.filter(v => Object.hasOwn(DETECTION_RULES, v)))].slice(0, 5) : [];
  const code = snapshot.timeout?.payload?.errorCode ?? snapshot.log?.payload?.errorCode;
  return {
    dataOrigin: p.smokeFixture === true ? 'ISOLATED_SYNTHETIC' : 'RECORDED_EVENT',
    incidentId: d.incidentId, guildId: id(d.guildId), targetUserId: id(d.targetId), detectedAt: time(d.occurredAt),
    detection: { rule: rules.length ? rules.join(', ') : 'UNKNOWN',
      reason: rules.length ? rules.map(v => DETECTION_RULES[v]).join('・') : 'UNKNOWN',
      count: integer(p.count), windowSeconds: typeof p.windowSeconds === 'number' && p.windowSeconds > 0 && p.windowSeconds <= 86400 ? p.windowSeconds : 'UNKNOWN',
      channelId: id(p.channelId), policyStrength: 'UNKNOWN (not recorded at detection)' },
    timeout: { status: status(snapshot.timeoutState, ['success', 'failed', 'skipped', 'unknown', 'pending_or_unknown', 'not_attempted']),
      durationSeconds: Number.isSafeInteger(t.durationMs) && t.durationMs > 0 && t.durationMs <= 28 * 86400_000 ? t.durationMs / 1000 : 'UNKNOWN',
      appliedAt: time(t.apiStartedAt), scheduledEnd: time(t.scheduledEndAt), actualEnd: time(t.actualEndAt) },
    discordLog: { status: status(snapshot.logState, ['sent', 'sent_edit_failed', 'failed', 'unknown', 'not_attempted', 'pending_or_unknown', 'sent_confirmation_pending']),
      channelId: id(snapshot.sent?.payload?.channelId), messageId: id(snapshot.sent?.payload?.messageId) },
    runtime: { version: /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(p.botVersion ?? '') ? p.botVersion.slice(0, 64) : 'UNKNOWN',
      commit: /^[a-f0-9]{7,40}$/i.test(p.botCommit ?? '') ? p.botCommit : 'UNKNOWN' },
    diagnostics: { safeErrorCode: code ? safeIncidentError({ code }) : 'NONE' },
  };
}

export function evidenceText(snapshot, { reportId, reporterId, reportedAt } = {}) {
  const e = safeEvidence(snapshot);
  const lines = ['NuviloView Security', reportId ? 'False Positive Report' : '検知データ', '',
    `Data Origin: ${e.dataOrigin}`,
    '記録時点の実行結果です。現在のTimeout残期間は再取得していません。',
    ...(e.dataOrigin === 'ISOLATED_SYNTHETIC' ? ['合成テスト記録です。実際のDiscord Timeoutは実行していません。'] : []),
    ...(reportId ? [`Report ID: ${reportIdFor(e.guildId, e.incidentId) === reportId ? reportId : 'UNKNOWN'}`,
      'Report Status: SUSPECTED_FALSE_POSITIVE', `Reported By: ${id(reporterId)}`, `Reported At: ${time(reportedAt)}`] : []),
    `Incident ID: ${e.incidentId}`, `Guild ID: ${e.guildId}`, `Target User ID: ${e.targetUserId}`, `Detected At: ${e.detectedAt}`];
  for (const key of ['detection', 'timeout', 'discordLog', 'runtime', 'diagnostics']) {
    lines.push('', `${key}:`);
    for (const [field, value] of Object.entries(e[key])) lines.push(`${field}: ${value}`);
  }
  const result = Buffer.from(lines.join('\n') + '\n', 'utf8');
  if (result.length > EVIDENCE_MAX_BYTES) throw new Error('EVIDENCE_TOO_LARGE');
  return result;
}

// Immutable events + existing Outbox, not a replayable Discord send queue.
// A durable claim is never released automatically, even after a crash/timeout.
export function createFalsePositiveReports({ audit, now = () => Date.now() }) {
  function read(guildId, incidentId, stage) {
    const row = audit.getModerationAudit(`${incidentId}:report_${stage}`);
    if (row && (row.guildId !== guildId || row.incidentId !== incidentId || row.action !== `report_${stage}`)) throw new Error('REPORT_MISMATCH');
    return row;
  }
  function write(guildId, incidentId, stage, reportStatus, reporterId, payload) {
    const parent = audit.getModerationAudit(incidentId);
    if (!parent || parent.guildId !== guildId || parent.action !== 'spam_detection' || !securityId(reporterId)) throw new Error('REPORT_MISMATCH');
    return audit.recordIncidentEvent({ eventId: `${incidentId}:report_${stage}`, incidentId, guildId,
      actorId: reporterId, targetId: parent.targetId, category: 'moderation', severity: 'medium', action: `report_${stage}`,
      status: reportStatus, occurredAt: now(), payload: { reportId: reportIdFor(guildId, incidentId), ...payload } });
  }
  return {
    state(guildId, incidentId) {
      const result = read(guildId, incidentId, 'result'), sent = read(guildId, incidentId, 'sent');
      return { status: result?.status ?? (sent ? 'SENT' : read(guildId, incidentId, 'sending') ? 'UNKNOWN'
        : read(guildId, incidentId, 'claim') ? 'CLAIMED' : 'NOT_REPORTED'), reportId: reportIdFor(guildId, incidentId) };
    },
    claim(guildId, incidentId, reporterId, destination) {
      if (![destination.guildId, destination.channelId].every(securityId)) throw new Error('INVALID_RECEIVER');
      return write(guildId, incidentId, 'claim', 'CLAIMED', reporterId,
        { destinationGuildId: destination.guildId, destinationChannelId: destination.channelId }).inserted;
    },
    sending(guildId, incidentId, reporterId) {
      if (!read(guildId, incidentId, 'claim')) throw new Error('REPORT_NOT_CLAIMED');
      return write(guildId, incidentId, 'sending', 'SENDING', reporterId, {}).inserted;
    },
    sent(guildId, incidentId, reporterId, messageId) {
      if (!securityId(messageId) || !read(guildId, incidentId, 'sending')) throw new Error('INVALID_DELIVERY');
      return write(guildId, incidentId, 'sent', 'SENT', reporterId, { messageId });
    },
    result(guildId, incidentId, reporterId, reportStatus, error = null) {
      if (!['SENT', 'FAILED', 'UNKNOWN'].includes(reportStatus) || !read(guildId, incidentId, 'sending')) throw new Error('INVALID_REPORT_STATUS');
      if (reportStatus === 'SENT' && !read(guildId, incidentId, 'sent')) throw new Error('REPORT_NOT_SENT');
      return write(guildId, incidentId, 'result', reportStatus, reporterId, { errorCode: error ? safeIncidentError(error) : null });
    },
    viewed(guildId, incidentId, reporterId) {
      // At most one disclosure audit per user/case; avoids unlimited rows on repeated views.
      return write(guildId, incidentId, `view_${reporterId}`, 'VIEWED', reporterId, {});
    },
  };
}
