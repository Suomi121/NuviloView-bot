import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";
import { analyticsProjectionKey } from "./analytics-projections.mjs";

const projectionKinds = new Set([
  "guild_current",
  "guild_daily",
  "channel_daily",
  "user_daily",
]);
const domains = new Set(["message", "reaction", "voice", "member"]);

function sha256(value) {
  return createHash("sha256").update(serializeJson(value)).digest("hex");
}

function utcDayEnd(dateUtc) {
  const start = Date.parse(`${dateUtc}T00:00:00.000Z`);
  return Number.isFinite(start) ? start + 86_400_000 : null;
}

function mapFoundation(row) {
  if (!row) return null;
  return {
    projectionKey: row.projection_key,
    projectionKind: row.projection_kind,
    guildId: row.guild_id,
    dateUtc: row.date_utc,
    channelId: row.channel_id,
    userId: row.user_id,
    state: row.state,
    finalizedThroughAt: Number(row.finalized_through_at),
    sourceSequence: Number(row.source_sequence),
    snapshotVersion: Number(row.snapshot_version),
    snapshotChecksum: row.snapshot_checksum,
    baselineMaterial: parseJson(row.baseline_material_json),
    baselineChecksum: row.baseline_checksum,
    baselineBuildDurationMs: Number(row.baseline_build_duration_ms),
    shadowCompareCount: Number(row.shadow_compare_count),
    shadowMismatchCount: Number(row.shadow_mismatch_count),
    lastComparedAt: row.last_compared_at == null ? null : Number(row.last_compared_at),
    lateEventGraceUntil: Number(row.late_event_grace_until),
    reconciledAt: Number(row.reconciled_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function snapshotMaterial(payload) {
  return {
    messageCount: Number(payload?.messageCount ?? 0),
    messageCreates: Number(payload?.messageActivity?.creates ?? payload?.messageCount ?? 0),
    messageEdits: Number(payload?.messageActivity?.edits ?? 0),
    messageDeletes: Number(payload?.messageActivity?.deletes ?? 0),
    messageReplies: Number(payload?.messageActivity?.replies ?? 0),
    reactionCount: Number(payload?.reactionCount ?? payload?.reactions?.count ?? 0),
    uniqueReactors: Number(payload?.uniqueReactors ?? payload?.reactions?.uniqueReactors ?? 0),
    reactedMessages: Number(payload?.reactedMessages ?? payload?.reactions?.reactedMessages ?? 0),
    reactionAdds: Number(payload?.reactions?.adds ?? 0),
    reactionRemoves: Number(payload?.reactions?.removes ?? 0),
    topReactions: payload?.topReactions ?? payload?.reactions?.top ?? [],
    voiceSeconds: Number(payload?.voiceSeconds ?? payload?.voice?.seconds ?? 0),
    voiceMinutes: Number(payload?.voiceMinutes ?? payload?.voice?.minutes ?? 0),
    voiceSessions: Number(payload?.voiceSessions ?? payload?.voice?.sessions ?? 0),
    openVoiceSessions: Number(payload?.openVoiceSessions ?? payload?.voice?.openSessions ?? 0),
    uniqueVoiceMembers: Number(payload?.uniqueVoiceMembers ?? payload?.voice?.uniqueMembers ?? 0),
    peakConcurrent: Number(payload?.peakConcurrent ?? payload?.voice?.peakConcurrent ?? 0),
    recoveredUnknownSessions: Number(payload?.voice?.recoveredUnknownSessions ?? 0),
    channelVoiceMinutes: payload?.channelVoiceMinutes ?? payload?.voice?.channelMinutes ?? [],
    joins: Number(payload?.joins ?? payload?.members?.joins ?? 0),
    leaves: Number(payload?.leaves ?? payload?.members?.leaves ?? 0),
    memberDelta: Number(payload?.memberDelta ?? payload?.members?.delta ?? 0),
    currentMemberCount: payload?.currentMemberCount ?? payload?.members?.currentCount ?? null,
    newMembers: Number(payload?.newMembers ?? payload?.members?.newMembers ?? payload?.joins ?? 0),
    activeMembers: Number(payload?.activeMembers ?? 0),
    lastMessageAt: payload?.lastMessageAt == null ? null : Number(payload.lastMessageAt),
    lastActivityAt: payload?.lastActivityAt == null ? null : Number(payload.lastActivityAt),
  };
}

export function createRetentionFoundationRepository(
  store,
  { analyticsProjections, snapshots, now = () => Date.now() } = {},
) {
  function get(projectionKey) {
    return mapFoundation(
      store.get(
        "SELECT * FROM analytics_retention_foundation WHERE projection_key = ?",
        requireString(projectionKey, "projectionKey"),
      ),
    );
  }

  function assertDomain(value) {
    const domain = String(value ?? "").trim().toLowerCase();
    if (!domains.has(domain)) throw new TypeError(`Unsupported retention domain: ${domain}.`);
    return domain;
  }

  function buildCurrentBaseline(guildId, cutoffAt) {
    const guild = requireString(guildId, "guildId");
    const cutoff = toEpochMilliseconds(cutoffAt, "cutoffAt");
    const message = store.get(
      `SELECT
         SUM(CASE WHEN event_type = 'create' THEN 1 ELSE 0 END) creates,
         SUM(CASE WHEN event_type = 'update' THEN 1 ELSE 0 END) edits,
         SUM(CASE WHEN event_type = 'delete' THEN 1 ELSE 0 END) deletes,
         SUM(CASE WHEN event_type = 'create'
                   AND json_extract(payload_json, '$.reference.messageId') IS NOT NULL
                  THEN 1 ELSE 0 END) replies,
         MAX(CASE WHEN event_type = 'create' THEN occurred_at END) last_message_at
       FROM message_event_log WHERE guild_id = ? AND occurred_at < ?`,
      guild,
      cutoff,
    );
    const reaction = store.get(
      `SELECT SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) adds,
              SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) removes,
              MAX(occurred_at) last_activity_at
       FROM reaction_events WHERE guild_id = ? AND occurred_at < ?`,
      guild,
      cutoff,
    );
    const voice = store.get(
      `SELECT MAX(occurred_at) last_activity_at
       FROM voice_events WHERE guild_id = ? AND occurred_at < ?`,
      guild,
      cutoff,
    );
    const member = store.get(
      `SELECT SUM(CASE WHEN event_type = 'join' THEN 1 ELSE 0 END) joins,
              SUM(CASE WHEN event_type = 'leave' THEN 1 ELSE 0 END) leaves,
              MAX(occurred_at) last_activity_at
       FROM member_events WHERE guild_id = ? AND occurred_at < ?`,
      guild,
      cutoff,
    );
    const lastActivityAt = Math.max(
      0,
      Number(message?.last_message_at ?? 0),
      Number(reaction?.last_activity_at ?? 0),
      Number(voice?.last_activity_at ?? 0),
      Number(member?.last_activity_at ?? 0),
    ) || null;
    const baseline = {
      messageCreates: Number(message?.creates ?? 0),
      messageEdits: Number(message?.edits ?? 0),
      messageDeletes: Number(message?.deletes ?? 0),
      messageReplies: Number(message?.replies ?? 0),
      reactionAdds: Number(reaction?.adds ?? 0),
      reactionRemoves: Number(reaction?.removes ?? 0),
      joins: Number(member?.joins ?? 0),
      leaves: Number(member?.leaves ?? 0),
      lastMessageAt: message?.last_message_at == null ? null : Number(message.last_message_at),
      lastActivityAt,
      finalizedThroughAt: cutoff,
    };
    return { ...baseline, checksum: sha256(baseline) };
  }

  function recentCurrentOperations(guildId, cutoffAt) {
    const guild = requireString(guildId, "guildId");
    const cutoff = toEpochMilliseconds(cutoffAt, "cutoffAt");
    const message = store.get(
      `SELECT
         SUM(CASE WHEN event_type = 'create' THEN 1 ELSE 0 END) creates,
         SUM(CASE WHEN event_type = 'update' THEN 1 ELSE 0 END) edits,
         SUM(CASE WHEN event_type = 'delete' THEN 1 ELSE 0 END) deletes,
         SUM(CASE WHEN event_type = 'create'
                   AND json_extract(payload_json, '$.reference.messageId') IS NOT NULL
                  THEN 1 ELSE 0 END) replies,
         MAX(CASE WHEN event_type = 'create' THEN occurred_at END) last_message_at
       FROM message_event_log WHERE guild_id = ? AND occurred_at >= ?`,
      guild,
      cutoff,
    );
    const reaction = store.get(
      `SELECT SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) adds,
              SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) removes
       FROM reaction_events WHERE guild_id = ? AND occurred_at >= ?`,
      guild,
      cutoff,
    );
    const member = store.get(
      `SELECT SUM(CASE WHEN event_type = 'join' THEN 1 ELSE 0 END) joins,
              SUM(CASE WHEN event_type = 'leave' THEN 1 ELSE 0 END) leaves
       FROM member_events WHERE guild_id = ? AND occurred_at >= ?`,
      guild,
      cutoff,
    );
    const recentLastActivity = store.get(
      `SELECT MAX(value) value FROM (
         SELECT MAX(occurred_at) value FROM message_event_log
           WHERE guild_id = ? AND event_type = 'create' AND occurred_at >= ?
         UNION ALL SELECT MAX(occurred_at) FROM reaction_events WHERE guild_id = ? AND occurred_at >= ?
         UNION ALL SELECT MAX(occurred_at) FROM voice_events WHERE guild_id = ? AND occurred_at >= ?
         UNION ALL SELECT MAX(occurred_at) FROM member_events WHERE guild_id = ? AND occurred_at >= ?
       )`,
      guild,
      cutoff,
      guild,
      cutoff,
      guild,
      cutoff,
      guild,
      cutoff,
    )?.value;
    return {
      messageCreates: Number(message?.creates ?? 0),
      messageEdits: Number(message?.edits ?? 0),
      messageDeletes: Number(message?.deletes ?? 0),
      messageReplies: Number(message?.replies ?? 0),
      reactionAdds: Number(reaction?.adds ?? 0),
      reactionRemoves: Number(reaction?.removes ?? 0),
      joins: Number(member?.joins ?? 0),
      leaves: Number(member?.leaves ?? 0),
      lastMessageAt: message?.last_message_at == null ? null : Number(message.last_message_at),
      lastActivityAt: recentLastActivity == null ? null : Number(recentLastActivity),
    };
  }

  function countCurrentActiveMembers(guildId) {
    const guild = requireString(guildId, "guildId");
    return Number(
      store.get(
        `SELECT COUNT(DISTINCT user_id) count FROM (
           SELECT user_id FROM local_message_active_member WHERE guild_id = ?
           UNION SELECT user_id FROM local_reaction_state
             WHERE guild_id = ? AND active = 1
           UNION SELECT user_id FROM local_voice_session WHERE guild_id = ?
         )`,
        guild,
        guild,
        guild,
      )?.count ?? 0,
    );
  }

  function composeCurrentMaterial(guildId, currentMaterial) {
    const projectionKey = analyticsProjectionKey({ kind: "guild_current", guildId });
    const foundation = get(projectionKey);
    if (!foundation) return { ...currentMaterial };
    const baseline = foundation.baselineMaterial;
    const recent = recentCurrentOperations(guildId, foundation.finalizedThroughAt);
    const sum = (key) => Number(baseline[key] ?? 0) + Number(recent[key] ?? 0);
    const messageCreates = sum("messageCreates");
    const joins = sum("joins");
    const leaves = sum("leaves");
    return {
      ...currentMaterial,
      messageCount: messageCreates,
      messageCreates,
      messageEdits: sum("messageEdits"),
      messageDeletes: sum("messageDeletes"),
      messageReplies: sum("messageReplies"),
      reactionAdds: sum("reactionAdds"),
      reactionRemoves: sum("reactionRemoves"),
      joins,
      leaves,
      memberDelta: joins - leaves,
      newMembers: joins,
      activeMembers: countCurrentActiveMembers(guildId),
      lastMessageAt: Math.max(
        0,
        Number(baseline.lastMessageAt ?? 0),
        Number(recent.lastMessageAt ?? 0),
      ) || null,
      lastActivityAt: Math.max(
        0,
        Number(baseline.lastActivityAt ?? 0),
        Number(recent.lastActivityAt ?? 0),
      ) || null,
    };
  }

  function planProjection(projectionKey, {
    cutoffAt,
    lateEventGraceUntil,
    reconciledAt,
    at = now(),
  } = {}) {
    const key = requireString(projectionKey, "projectionKey");
    const cutoff = toEpochMilliseconds(cutoffAt, "cutoffAt");
    const graceUntil = toEpochMilliseconds(lateEventGraceUntil, "lateEventGraceUntil");
    const reconciliation = toEpochMilliseconds(reconciledAt, "reconciledAt");
    const dirty = analyticsProjections.getDirty(key);
    const snapshot = snapshots.get("analytics", key);
    const reasons = [];
    if (!dirty) reasons.push("PROJECTION_TRACKING_MISSING");
    else {
      if (dirty.dirty || dirty.lastAggregatedSequence < dirty.sourceSequence) {
        reasons.push("DIRTY_PROJECTION");
      }
      const bucketEnd = dirty.dateUtc ? utcDayEnd(dirty.dateUtc) : null;
      if (bucketEnd != null && bucketEnd > cutoff) reasons.push("BUCKET_NOT_CLOSED");
    }
    if (!snapshot) reasons.push("SNAPSHOT_MISSING");
    else {
      if (snapshot.dirty) reasons.push("REQUIRED_PROVIDER_INCOMPLETE");
      if (Number(snapshot.payload?.schemaVersion) !== 4 || Number(snapshot.payload?.projectionVersion) !== 2) {
        reasons.push("PROJECTION_CONTRACT_UNSUPPORTED");
      }
      const delivery = store.get(
        `SELECT COUNT(*) required_count,
                SUM(CASE WHEN status <> 'synced' THEN 1 ELSE 0 END) incomplete,
                SUM(CASE WHEN remote_checksum IS NULL OR remote_checksum <> checksum
                         THEN 1 ELSE 0 END) checksum_mismatch,
                MAX(synced_at) last_synced_at
         FROM sync_provider_snapshot_delivery
         WHERE snapshot_type = 'analytics' AND aggregate_id = ?
           AND provider_required = 1`,
        key,
      );
      if (Number(delivery?.required_count ?? 0) === 0) reasons.push("REQUIRED_PROVIDER_MISSING");
      if (Number(delivery?.incomplete ?? 0) > 0) reasons.push("REQUIRED_PROVIDER_INCOMPLETE");
      if (Number(delivery?.checksum_mismatch ?? 0) > 0) reasons.push("PROVIDER_CHECKSUM_MISMATCH");
      if (reconciliation < Number(delivery?.last_synced_at ?? 0)) {
        reasons.push("RECONCILIATION_STALE");
      }
    }
    if (at < graceUntil) reasons.push("LATE_EVENT_GRACE_ACTIVE");
    if (dirty) {
      const activeHistory = store.get(
        `SELECT COUNT(*) count FROM history_import_local_job
         WHERE guild_id = ? AND status NOT IN ('completed', 'cancelled')`,
        dirty.guildId,
      );
      if (Number(activeHistory?.count ?? 0) > 0) reasons.push("HISTORY_IMPORT_ACTIVE");
      const openVoice = store.get(
        `SELECT COUNT(*) count FROM local_voice_session
         WHERE guild_id = ? AND ended_at IS NULL AND started_at < ?`,
        dirty.guildId,
        cutoff,
      );
      if (Number(openVoice?.count ?? 0) > 0) reasons.push("OPEN_VOICE_SESSION");
      const queue = store.get(
        `SELECT COUNT(*) count FROM sync_outbox
         WHERE status <> 'synced'
           AND json_extract(payload_json, '$.guildId') = ?
           AND CAST(json_extract(payload_json, '$.occurredAt') AS INTEGER) < ?`,
        dirty.guildId,
        cutoff,
      );
      if (Number(queue?.count ?? 0) > 0) reasons.push("OUTBOX_NOT_COMPLETE");
    }
    return {
      eligible: reasons.length === 0,
      reasons: [...new Set(reasons)],
      projectionKey: key,
      dirty,
      snapshot,
      cutoffAt: cutoff,
      lateEventGraceUntil: graceUntil,
      reconciledAt: reconciliation,
    };
  }

  function createShadow(input, options = {}) {
    const plan = planProjection(input?.projectionKey, options);
    if (!plan.eligible) return { created: false, plan, foundation: null };
    const dirty = plan.dirty;
    if (!projectionKinds.has(dirty.projectionKind)) {
      throw new TypeError(`Unsupported projection kind: ${dirty.projectionKind}.`);
    }
    const buildStartedAt = performance.now();
    const baseline = dirty.projectionKind === "guild_current"
      ? buildCurrentBaseline(dirty.guildId, plan.cutoffAt)
      : {};
    const baselineBuildDurationMs = performance.now() - buildStartedAt;
    const baselinePayload = dirty.projectionKind === "guild_current"
      ? Object.fromEntries(Object.entries(baseline).filter(([key]) => key !== "checksum"))
      : {};
    const at = Number(options.at ?? now());
    store.run(
      `INSERT INTO analytics_retention_foundation (
         projection_key, projection_kind, guild_id, date_utc, channel_id, user_id,
         state, finalized_through_at, source_sequence, snapshot_version,
         snapshot_checksum, baseline_material_json, baseline_checksum,
         baseline_build_duration_ms, late_event_grace_until, reconciled_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (projection_key) DO UPDATE SET
         projection_kind = excluded.projection_kind,
         guild_id = excluded.guild_id,
         date_utc = excluded.date_utc,
         channel_id = excluded.channel_id,
         user_id = excluded.user_id,
         state = 'shadow',
         finalized_through_at = excluded.finalized_through_at,
         source_sequence = excluded.source_sequence,
         snapshot_version = excluded.snapshot_version,
         snapshot_checksum = excluded.snapshot_checksum,
         baseline_material_json = excluded.baseline_material_json,
         baseline_checksum = excluded.baseline_checksum,
         baseline_build_duration_ms = excluded.baseline_build_duration_ms,
         late_event_grace_until = excluded.late_event_grace_until,
         reconciled_at = excluded.reconciled_at,
         updated_at = excluded.updated_at`,
      dirty.projectionKey,
      dirty.projectionKind,
      dirty.guildId,
      dirty.dateUtc,
      dirty.channelId,
      dirty.userId,
      plan.cutoffAt,
      dirty.sourceSequence,
      plan.snapshot.snapshotVersion,
      plan.snapshot.checksum,
      serializeJson(baselinePayload),
      baseline.checksum ?? null,
      baselineBuildDurationMs,
      plan.lateEventGraceUntil,
      plan.reconciledAt,
      at,
      at,
    );
    return { created: true, plan, foundation: get(dirty.projectionKey) };
  }

  function resolveMaterial(projectionKey) {
    const foundation = get(projectionKey);
    if (!foundation) return null;
    const dirty = analyticsProjections.getDirty(projectionKey);
    if (!dirty) return null;
    const snapshot = snapshots.get("analytics", projectionKey);
    if (foundation.projectionKind === "guild_current") {
      if (sha256(foundation.baselineMaterial) !== foundation.baselineChecksum) {
        return { safe: false, reason: "BASELINE_CHECKSUM_MISMATCH", material: null };
      }
      const current = analyticsProjections.buildMaterial(dirty);
      return {
        safe: true,
        reason: "BASELINE_PLUS_RECENT_RAW",
        material: composeCurrentMaterial(foundation.guildId, current),
      };
    }
    if (
      !snapshot ||
      snapshot.snapshotVersion !== foundation.snapshotVersion ||
      snapshot.checksum !== foundation.snapshotChecksum
    ) {
      return { safe: false, reason: "BASELINE_SNAPSHOT_CHANGED", material: null };
    }
    return {
      safe: true,
      reason: "IMMUTABLE_SNAPSHOT_BASELINE",
      material: snapshotMaterial(snapshot.payload),
    };
  }

  function compareShadow(projectionKey) {
    const dirty = analyticsProjections.getDirty(projectionKey);
    const resolved = resolveMaterial(projectionKey);
    if (!dirty || !resolved?.safe) {
      return { compared: false, matched: false, reason: resolved?.reason ?? "FOUNDATION_MISSING" };
    }
    const expected = analyticsProjections.buildMaterial(dirty);
    const matched = serializeJson(expected) === serializeJson(resolved.material);
    store.run(
      `UPDATE analytics_retention_foundation
       SET shadow_compare_count = shadow_compare_count + 1,
           shadow_mismatch_count = shadow_mismatch_count + ?,
           last_compared_at = ?, updated_at = ?
       WHERE projection_key = ?`,
      matched ? 0 : 1,
      now(),
      now(),
      requireString(projectionKey, "projectionKey"),
    );
    return {
      compared: true,
      matched,
      expectedChecksum: sha256(expected),
      actualChecksum: sha256(resolved.material),
      reason: resolved.reason,
    };
  }

  function classifyEvent(input) {
    const lookupStartedAt = performance.now();
    const domain = assertDomain(input?.domain);
    const guildId = requireString(input?.guildId, "guildId");
    requireString(input?.partitionKey, "partitionKey");
    const eventId = requireString(input?.eventId, "eventId");
    const occurredAt = toEpochMilliseconds(input?.occurredAt, "occurredAt");
    const sourceSequence = Number(input?.sourceSequence);
    if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 0) {
      throw new TypeError("sourceSequence must be a non-negative safe integer.");
    }
    const currentKey = analyticsProjectionKey({ kind: "guild_current", guildId });
    const foundation = get(currentKey);
    if (!foundation || occurredAt >= foundation.finalizedThroughAt) {
      return {
        decision: "ACCEPT_RECENT",
        foundation,
        dedupeLookupLatencyMs: performance.now() - lookupStartedAt,
      };
    }
    const existing = store.get(
      "SELECT event_id, checksum, replay_count FROM retention_late_event_queue WHERE event_id = ?",
      eventId,
    );
    if (existing) {
      return {
        decision: "REJECT_DUPLICATE_LATE_EVENT",
        foundation,
        receipt: {
          eventId: existing.event_id,
          checksum: existing.checksum,
          replayCount: Number(existing.replay_count),
        },
        dedupeLookupLatencyMs: performance.now() - lookupStartedAt,
      };
    }
    return {
      decision: "QUEUE_MANUAL_REPAIR",
      foundation,
      dedupeLookupLatencyMs: performance.now() - lookupStartedAt,
    };
  }

  function queueLateEvent(input, { at = now() } = {}) {
    const classification = classifyEvent(input);
    if (classification.decision !== "QUEUE_MANUAL_REPAIR") {
      return { queued: false, classification };
    }
    const payload = input?.payload ?? {};
    const checksum = sha256(payload);
    store.run(
      `INSERT INTO retention_late_event_queue (
         event_id, domain, guild_id, partition_key, event_type, occurred_at,
         source_sequence, payload_json, checksum, status, reason,
         first_seen_at, last_seen_at, replay_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0)
       ON CONFLICT (event_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         replay_count = retention_late_event_queue.replay_count + 1`,
      requireString(input?.eventId, "eventId"),
      assertDomain(input?.domain),
      requireString(input?.guildId, "guildId"),
      requireString(input?.partitionKey, "partitionKey"),
      requireString(input?.eventType, "eventType"),
      toEpochMilliseconds(input?.occurredAt, "occurredAt"),
      Number(input?.sourceSequence),
      serializeJson(payload),
      checksum,
      "FINALIZED_BOUNDARY_LATE_EVENT",
      at,
      at,
    );
    return { queued: true, classification, checksum };
  }

  function getMetrics() {
    const rows = store.get(
      `SELECT COUNT(*) baseline_count,
              COALESCE(SUM(length(baseline_material_json)), 0) baseline_bytes,
              SUM(CASE WHEN state = 'shadow' THEN 1 ELSE 0 END) shadow_count,
              COALESCE(SUM(shadow_compare_count), 0) compare_count,
              COALESCE(SUM(shadow_mismatch_count), 0) mismatch_count,
              COALESCE(MAX(baseline_build_duration_ms), 0) max_build_ms,
              MIN(finalized_through_at) oldest_boundary,
              MAX(finalized_through_at) newest_boundary
       FROM analytics_retention_foundation`,
    );
    const late = store.get(
      `SELECT COUNT(*) count,
              SUM(CASE WHEN status IN ('queued', 'reviewing') THEN 1 ELSE 0 END) open
       FROM retention_late_event_queue`,
    );
    return {
      foundationSchemaVersion: 1,
      baselineCount: Number(rows?.baseline_count ?? 0),
      baselineBytesEstimate: Number(rows?.baseline_bytes ?? 0),
      shadowCount: Number(rows?.shadow_count ?? 0),
      shadowCompareCount: Number(rows?.compare_count ?? 0),
      shadowMismatchCount: Number(rows?.mismatch_count ?? 0),
      maxBaselineBuildDurationMs: Number(rows?.max_build_ms ?? 0),
      oldestFinalizedThrough: rows?.oldest_boundary == null ? null : Number(rows.oldest_boundary),
      newestFinalizedThrough: rows?.newest_boundary == null ? null : Number(rows.newest_boundary),
      dedupeEntries: Number(late?.count ?? 0),
      lateEventCount: Number(late?.count ?? 0),
      openLateEventCount: Number(late?.open ?? 0),
    };
  }

  return Object.freeze({
    get,
    buildCurrentBaseline,
    composeCurrentMaterial,
    planProjection,
    createShadow,
    resolveMaterial,
    compareShadow,
    classifyEvent,
    queueLateEvent,
    getMetrics,
  });
}

export const retentionFoundationInternals = Object.freeze({
  snapshotMaterial,
  sha256,
});
