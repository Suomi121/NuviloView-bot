import { randomUUID } from "node:crypto";

function severityForAction(action) {
  return action === "ban" || action === "spam_timeout" ? "high" : "medium";
}

function auditEnvelope(record, eventType) {
  return {
    eventId: record.eventId,
    // Security is an existing local-replica domain. The event type keeps the
    // immutable audit stream distinguishable without creating a raw analytics
    // replica domain.
    domain: "security",
    eventType,
    aggregateId: `security:${record.guildId}:${record.incidentId ?? record.eventId}`,
    payload: {
      eventId: record.eventId,
      guildId: record.guildId,
      incidentId: record.incidentId,
      category: record.category,
      severity: record.severity,
      action: record.action,
      actorId: record.actorId,
      targetId: record.targetId,
      status: record.status,
      occurredAt: record.occurredAt,
      details: record.payload,
    },
    schemaVersion: 1,
    priority: record.severity === "high" || record.severity === "critical" ? 10 : 5,
    createdAt: record.occurredAt,
  };
}

export function createSecurityAuditService({
  storage,
  now = () => Date.now(),
} = {}) {
  if (!storage?.enabled || !storage?.writeEnabled) {
    const error = new Error("Writable SQLite is required for Security Audit.");
    error.code = "SECURITY_LOCAL_STORAGE_NOT_WRITABLE";
    throw error;
  }

  function persist(input, eventType) {
    return storage.transaction(() => {
      const record = storage.security.appendAudit(input);
      if (record.inserted) {
        storage.outbox.enqueue(auditEnvelope(record, eventType));
      }
      return record;
    });
  }

  function startModeration(input) {
    const incidentId = String(input?.incidentId ?? randomUUID());
    return persist({
      eventId: incidentId,
      guildId: input.guildId,
      incidentId,
      category: "moderation",
      severity: input.severity ?? severityForAction(input.action),
      action: input.action,
      actorId: input.actorId,
      targetId: input.targetId,
      status: "pending",
      occurredAt: input.occurredAt ?? now(),
      payload: {
        guildName: input.guildName ?? null,
        actorName: input.actorName ?? null,
        targetName: input.targetName ?? null,
        channelId: input.channelId ?? null,
        reason: input.reason ?? null,
        requestedCount: input.requestedCount ?? null,
      },
    }, "moderation_audit_started");
  }

  function completeModeration(incidentId, input) {
    const started = storage.security.getByEventId(incidentId);
    if (!started) {
      const error = new Error("The local Moderation audit could not be found.");
      error.code = "SECURITY_AUDIT_NOT_FOUND";
      throw error;
    }
    return persist({
      eventId: `${incidentId}:completion`,
      guildId: started.guildId,
      incidentId,
      category: started.category,
      severity: started.severity,
      action: started.action,
      actorId: started.actorId,
      targetId: started.targetId,
      status: input.status,
      occurredAt: input.occurredAt ?? now(),
      payload: {
        affectedCount: input.affectedCount ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      },
    }, "moderation_audit_completed");
  }

  return Object.freeze({
    startModeration,
    completeModeration,
    getModerationAudit: (incidentId) => storage.security.getByEventId(incidentId),
  });
}
