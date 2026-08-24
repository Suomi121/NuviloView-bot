import {
  createStableEventId,
  optionalString,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

const severities = new Set(["info", "low", "medium", "high", "critical"]);

function mapAudit(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    guildId: row.guild_id,
    incidentId: row.incident_id,
    category: row.category,
    severity: row.severity,
    action: row.action,
    actorId: row.actor_id,
    targetId: row.target_id,
    status: row.status,
    payload: parseJson(row.payload_json),
    occurredAt: Number(row.occurred_at),
    createdAt: Number(row.created_at),
  };
}

export function createSecurityRepository(store, { now = () => Date.now() } = {}) {
  function getByEventId(eventId) {
    return mapAudit(
      store.get(
        `SELECT event_id, guild_id, incident_id, category, severity, action,
                actor_id, target_id, status, payload_json, occurred_at, created_at
         FROM security_audit WHERE event_id = ?`,
        requireString(eventId, "eventId"),
      ),
    );
  }

  function appendAudit(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const category = requireString(input?.category, "category");
    const action = requireString(input?.action, "action");
    const severity = String(input?.severity ?? "info").toLowerCase();
    if (!severities.has(severity)) {
      throw new TypeError("severity must be info, low, medium, high, or critical.");
    }
    const status = requireString(input?.status ?? "recorded", "status");
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const incidentId = optionalString(input?.incidentId);
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId("security", [
          guildId,
          incidentId ?? category,
          action,
          occurredAt,
        ]);
    const result = store.run(
      `INSERT OR IGNORE INTO security_audit (
         event_id, guild_id, incident_id, category, severity, action,
         actor_id, target_id, status, payload_json, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      guildId,
      incidentId,
      category,
      severity,
      action,
      optionalString(input?.actorId),
      optionalString(input?.targetId),
      status,
      serializeJson(input?.payload),
      occurredAt,
      now(),
    );
    return {
      ...getByEventId(eventId),
      inserted: Number(result.changes) === 1,
    };
  }

  return Object.freeze({ appendAudit, getByEventId });
}
