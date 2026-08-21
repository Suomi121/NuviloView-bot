export const SECURITY_V1_INCIDENT_TYPES = Object.freeze({
  CHANNEL: "CHANNEL_NUKE",
  ROLE: "ROLE_NUKE",
  WEBHOOK: "WEBHOOK_NUKE",
  DUPLICATE_SPAM: "BOT_DUPLICATE_SPAM",
  EVERYONE_SPAM: "BOT_EVERYONE_SPAM",
});

export const DEFAULT_SECURITY_V1_THRESHOLDS = Object.freeze({
  channelActionThreshold: 5,
  channelWindowSeconds: 60,
  roleActionThreshold: 2,
  roleWindowSeconds: 60,
  webhookThreshold: 2,
  webhookWindowSeconds: 60 * 60,
  botDuplicateThreshold: 5,
  botDuplicateWindowSeconds: 20,
  botEveryoneThreshold: 3,
  botEveryoneWindowSeconds: 20,
});

export const DEFAULT_SECURITY_V1_POLICY = Object.freeze({
  channelProtection: true,
  roleProtection: true,
  autoRestore: false,
  webhookProtection: true,
  botSpamProtection: true,
  botDuplicateSpam: true,
  botEveryoneSpam: true,
  automaticContainment: false,
  detectorThresholds: DEFAULT_SECURITY_V1_THRESHOLDS,
});

const detectorDefinitions = Object.freeze({
  CHANNEL_CREATE: { incidentType: SECURITY_V1_INCIDENT_TYPES.CHANNEL, enabledKey: "channelProtection", thresholdKey: "channelActionThreshold", windowKey: "channelWindowSeconds", severity: "Critical" },
  CHANNEL_DELETE: { incidentType: SECURITY_V1_INCIDENT_TYPES.CHANNEL, enabledKey: "channelProtection", thresholdKey: "channelActionThreshold", windowKey: "channelWindowSeconds", severity: "Critical" },
  ROLE_CREATE: { incidentType: SECURITY_V1_INCIDENT_TYPES.ROLE, enabledKey: "roleProtection", thresholdKey: "roleActionThreshold", windowKey: "roleWindowSeconds", severity: "Critical" },
  ROLE_DELETE: { incidentType: SECURITY_V1_INCIDENT_TYPES.ROLE, enabledKey: "roleProtection", thresholdKey: "roleActionThreshold", windowKey: "roleWindowSeconds", severity: "Critical" },
  WEBHOOK_CREATE: { incidentType: SECURITY_V1_INCIDENT_TYPES.WEBHOOK, enabledKey: "webhookProtection", thresholdKey: "webhookThreshold", windowKey: "webhookWindowSeconds", severity: "High" },
  BOT_DUPLICATE_SPAM: { incidentType: SECURITY_V1_INCIDENT_TYPES.DUPLICATE_SPAM, enabledKey: "botDuplicateSpam", thresholdKey: "botDuplicateThreshold", windowKey: "botDuplicateWindowSeconds", severity: "High", fingerprinted: true },
  BOT_EVERYONE_SPAM: { incidentType: SECURITY_V1_INCIDENT_TYPES.EVERYONE_SPAM, enabledKey: "botEveryoneSpam", thresholdKey: "botEveryoneThreshold", windowKey: "botEveryoneWindowSeconds", severity: "High" },
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function normalizeSecurityV1Thresholds(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    channelActionThreshold: boundedInteger(source.channelActionThreshold, 5, 2, 20),
    channelWindowSeconds: boundedInteger(source.channelWindowSeconds, 60, 10, 300),
    roleActionThreshold: boundedInteger(source.roleActionThreshold, 2, 2, 10),
    roleWindowSeconds: boundedInteger(source.roleWindowSeconds, 60, 10, 300),
    webhookThreshold: boundedInteger(source.webhookThreshold, 2, 2, 20),
    webhookWindowSeconds: boundedInteger(source.webhookWindowSeconds, 3_600, 60, 86_400),
    botDuplicateThreshold: boundedInteger(source.botDuplicateThreshold, 5, 3, 20),
    botDuplicateWindowSeconds: boundedInteger(source.botDuplicateWindowSeconds, 20, 5, 120),
    botEveryoneThreshold: boundedInteger(source.botEveryoneThreshold, 3, 2, 10),
    botEveryoneWindowSeconds: boundedInteger(source.botEveryoneWindowSeconds, 20, 5, 120),
  };
}

export function normalizeSecurityV1Policy(input = {}) {
  return {
    channelProtection: input.channelProtection !== false,
    roleProtection: input.roleProtection !== false,
    autoRestore: input.autoRestore === true,
    webhookProtection: input.webhookProtection !== false,
    botSpamProtection: input.botSpamProtection !== false,
    botDuplicateSpam: input.botDuplicateSpam !== false,
    botEveryoneSpam: input.botEveryoneSpam !== false,
    automaticContainment: input.automaticContainment === true,
    detectorThresholds: normalizeSecurityV1Thresholds(input.detectorThresholds),
  };
}

export function getSecurityV1Detector(actionType, policyInput = {}) {
  const definition = detectorDefinitions[actionType];
  if (!definition) return null;
  const policy = normalizeSecurityV1Policy(policyInput);
  const spamDetector = actionType === "BOT_DUPLICATE_SPAM" || actionType === "BOT_EVERYONE_SPAM";
  const enabled = policy[definition.enabledKey] && (!spamDetector || policy.botSpamProtection);
  return {
    ...definition,
    enabled,
    threshold: policy.detectorThresholds[definition.thresholdKey],
    windowMs: policy.detectorThresholds[definition.windowKey] * 1_000,
  };
}

export function shouldMonitorSecurityV1Actor({ actorId, selfBotId, trustedActor, actorIsBot }) {
  return Boolean(actorId) && actorIsBot === true && actorId !== selfBotId && trustedActor !== true;
}

export function hasEveryoneOrHereMention(message) {
  if (typeof message?.mentions?.everyone === "boolean") return message.mentions.everyone;
  return /@(?:everyone|here)\b/i.test(String(message?.content ?? ""));
}

function safeEvent(event, now) {
  return {
    guildId: String(event.guildId),
    actorId: String(event.actorId),
    actionType: String(event.actionType),
    auditLogEntryId: event.auditLogEntryId ? String(event.auditLogEntryId) : null,
    targetId: event.targetId ? String(event.targetId) : null,
    channelId: event.channelId ? String(event.channelId) : null,
    messageId: event.messageId ? String(event.messageId) : null,
    fingerprint: event.fingerprint ? String(event.fingerprint).slice(0, 128) : null,
    targetName: event.targetName ? String(event.targetName).slice(0, 100) : null,
    occurredAt: Number.isFinite(event.occurredAt) ? event.occurredAt : now,
  };
}

export class SecurityV1WindowTracker {
  constructor({ maximumKeys = 5_000, maximumEventsPerKey = 100, incidentCooldownMs = 5 * 60_000 } = {}) {
    this.maximumKeys = maximumKeys;
    this.maximumEventsPerKey = maximumEventsPerKey;
    this.incidentCooldownMs = incidentCooldownMs;
    this.windows = new Map();
    this.cooldowns = new Map();
    this.seenEvents = new Map();
  }

  record(event, policyInput = {}, now = Date.now()) {
    const detector = getSecurityV1Detector(event.actionType, policyInput);
    if (!detector?.enabled || !event.guildId || !event.actorId) {
      return { detected: false, count: 0, detector };
    }
    const fingerprint = detector.fingerprinted ? String(event.fingerprint ?? "") : "";
    if (detector.fingerprinted && !fingerprint) return { detected: false, count: 0, detector };
    const eventId = event.auditLogEntryId
      ? `${event.guildId}:${event.actionType}:${String(event.auditLogEntryId)}`
      : null;
    if (eventId && (this.seenEvents.get(eventId) ?? 0) > now) {
      return { detected: false, duplicateSuppressed: true, count: 0, detector };
    }
    if (eventId) this.seenEvents.set(eventId, now + Math.max(detector.windowMs, this.incidentCooldownMs));
    const key = `${event.guildId}:${event.actorId}:${detector.incidentType}:${fingerprint}`;
    const cutoff = now - detector.windowMs;
    const previous = this.windows.get(key)?.events ?? [];
    const events = previous.filter((item) => item.occurredAt >= cutoff);
    events.push(safeEvent(event, now));
    if (events.length > this.maximumEventsPerKey) events.splice(0, events.length - this.maximumEventsPerKey);
    this.windows.set(key, { guildId: String(event.guildId), lastSeenAt: now, events });
    this.prune(now);

    const cooldownUntil = this.cooldowns.get(key) ?? 0;
    if (events.length < detector.threshold || cooldownUntil > now) {
      return {
        detected: false,
        duplicateSuppressed: cooldownUntil > now,
        count: events.length,
        detector,
        events: [...events],
      };
    }
    // A webhook detector can intentionally use a much wider window than the
    // channel/role and message detectors. Keep one incident for that full
    // window so the same burst cannot emit a new incident every five minutes.
    this.cooldowns.set(key, now + Math.max(this.incidentCooldownMs, detector.windowMs));
    return { detected: true, count: events.length, detector, events: [...events] };
  }

  prune(now = Date.now()) {
    const maximumWindowMs = 86_400_000;
    for (const [key, value] of this.windows) {
      const events = value.events.filter((event) => event.occurredAt >= now - maximumWindowMs);
      if (events.length === 0) this.windows.delete(key);
      else this.windows.set(key, { ...value, events });
    }
    for (const [key, expiresAt] of this.cooldowns) {
      if (expiresAt <= now) this.cooldowns.delete(key);
    }
    for (const [key, expiresAt] of this.seenEvents) {
      if (expiresAt <= now) this.seenEvents.delete(key);
    }
    if (this.windows.size <= this.maximumKeys) return;
    const oldest = [...this.windows.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, this.windows.size - this.maximumKeys);
    for (const [key] of oldest) {
      this.windows.delete(key);
      this.cooldowns.delete(key);
    }
  }

  clearGuild(guildId) {
    const prefix = `${guildId}:`;
    for (const key of this.windows.keys()) if (key.startsWith(prefix)) this.windows.delete(key);
    for (const key of this.cooldowns.keys()) if (key.startsWith(prefix)) this.cooldowns.delete(key);
    for (const key of this.seenEvents.keys()) if (key.startsWith(`${guildId}:`)) this.seenEvents.delete(key);
  }
}

export async function executeBestEffort(items, worker) {
  const results = [];
  for (const item of items) {
    try {
      results.push({ item, status: "restored", value: await worker(item) });
    } catch (error) {
      results.push({ item, status: "failed", error: String(error?.message ?? error).slice(0, 500) });
    }
  }
  return results;
}

export function summarizeBestEffort(results) {
  const restored = results.filter((item) => item.status === "restored").length;
  const failed = results.length - restored;
  return {
    restored,
    failed,
    status: failed === 0 ? "restored" : restored > 0 ? "partially_restored" : "failed",
  };
}
