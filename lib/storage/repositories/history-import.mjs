import { createHash } from "node:crypto";
import {
  createStableEventId,
  optionalString,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

const allowedStatuses = new Set([
  "queued",
  "preparing",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "stalled",
]);

function status(value) {
  const normalized = requireString(value, "status");
  if (!allowedStatuses.has(normalized)) {
    throw new TypeError(`Unsupported History Import status: ${normalized}.`);
  }
  return normalized;
}

function nonNegativeInteger(value, fieldName) {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
  return normalized;
}

function sourceRecord(record, now) {
  const guildId = requireString(record?.guildId, "guildId");
  const channelId = requireString(record?.channelId, "channelId");
  const messageId = requireString(record?.id ?? record?.messageId, "messageId");
  const occurredAt = toEpochMilliseconds(record?.createdAt, "createdAt");
  const content = String(record?.content ?? "");
  const contentChecksum = createHash("sha256").update(content).digest("hex");
  const sourceSequence = occurredAt;
  return {
    eventId: createStableEventId("message-create", [guildId, messageId]),
    guildId,
    channelId,
    channelName: optionalString(record?.channelName),
    messageId,
    authorId: optionalString(record?.authorId),
    actorName: String(record?.authorName ?? "Unknown"),
    eventType: "create",
    revision: `create:${sourceSequence}:${contentChecksum}`,
    sourceSequence,
    content,
    contentChecksum,
    occurredAt,
    source: "history_import",
    importJobId: requireString(record?.importJobId, "importJobId"),
    memberCount: null,
    payload: {
      guildId,
      channelId,
      channelName: optionalString(record?.channelName),
      messageId,
      authorId: optionalString(record?.authorId),
      authorName: String(record?.authorName ?? "Unknown"),
      authorIsBot: false,
      authorRoleIds: Array.isArray(record?.authorRoleIds)
        ? record.authorRoleIds.map(String).sort()
        : [],
      content,
      contentChecksum,
      eventType: "create",
      revision: `create:${sourceSequence}:${contentChecksum}`,
      sourceSequence,
      occurredAt,
      source: "history_import",
      importJobId: requireString(record?.importJobId, "importJobId"),
      importedAt: now,
    },
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    guildId: row.guild_id,
    status: row.status,
    fetchedCount: Number(row.fetched_count),
    eligibleCount: Number(row.eligible_count),
    insertedCount: Number(row.inserted_count),
    duplicateCount: Number(row.duplicate_count),
    failedCount: Number(row.failed_count),
    currentChannelId: row.current_channel_id,
    retryState: row.retry_state,
    retryAfterAt: row.retry_after_at == null ? null : Number(row.retry_after_at),
    lastCheckpointAt:
      row.last_checkpoint_at == null ? null : Number(row.last_checkpoint_at),
    lastHeartbeatAt:
      row.last_heartbeat_at == null ? null : Number(row.last_heartbeat_at),
    metadata: parseJson(row.metadata_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapChannel(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    channelProgressId: row.channel_progress_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    status: row.status,
    nextBeforeMessageId: row.next_before_message_id,
    oldestMessageId: row.oldest_message_id,
    fetchedCount: Number(row.fetched_count),
    eligibleCount: Number(row.eligible_count),
    insertedCount: Number(row.inserted_count),
    duplicateCount: Number(row.duplicate_count),
    failedCount: Number(row.failed_count),
    retryCount: Number(row.retry_count),
    retryAfterAt: row.retry_after_at == null ? null : Number(row.retry_after_at),
    lastProgressAt:
      row.last_progress_at == null ? null : Number(row.last_progress_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapBatch(row) {
  if (!row) return null;
  return {
    batchId: row.batch_id,
    jobId: row.job_id,
    channelProgressId: row.channel_progress_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    requestBeforeMessageId: row.request_before_message_id,
    nextBeforeMessageId: row.next_before_message_id,
    oldestMessageId: row.oldest_message_id,
    fetchedCount: Number(row.fetched_count),
    eligibleCount: Number(row.eligible_count),
    insertedCount: Number(row.inserted_count),
    duplicateCount: Number(row.duplicate_count),
    createdAt: Number(row.created_at),
  };
}

export function createHistoryImportRepository(
  store,
  messageDomain,
  analyticsProjections,
  { now = () => Date.now() } = {},
) {
  function inTransaction(callback) {
    return store.transactionActive ? callback() : store.transaction(callback);
  }

  function getJob(jobId) {
    return mapJob(
      store.get(
        "SELECT * FROM history_import_local_job WHERE job_id = ?",
        requireString(jobId, "jobId"),
      ),
    );
  }

  function ensureJob(input) {
    const jobId = requireString(input?.jobId ?? input?.id, "jobId");
    const guildId = requireString(input?.guildId, "guildId");
    const jobStatus = status(input?.status ?? "queued");
    const at = now();
    store.run(
      `INSERT INTO history_import_local_job (
         job_id, guild_id, status, current_channel_id, last_heartbeat_at,
         metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET
         guild_id = excluded.guild_id,
         status = excluded.status,
         current_channel_id = COALESCE(
           excluded.current_channel_id,
           history_import_local_job.current_channel_id
         ),
         last_heartbeat_at = COALESCE(
           excluded.last_heartbeat_at,
           history_import_local_job.last_heartbeat_at
         ),
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      jobId,
      guildId,
      jobStatus,
      optionalString(input?.currentChannelId),
      input?.lastHeartbeatAt == null
        ? null
        : toEpochMilliseconds(input.lastHeartbeatAt, "lastHeartbeatAt"),
      serializeJson(input?.metadata ?? { schemaVersion: 3 }),
      at,
      at,
    );
    return getJob(jobId);
  }

  function getChannel(jobId, channelId) {
    return mapChannel(
      store.get(
        `SELECT * FROM history_import_local_channel
         WHERE job_id = ? AND channel_id = ?`,
        requireString(jobId, "jobId"),
        requireString(channelId, "channelId"),
      ),
    );
  }

  function getChannelByProgressId(jobId, channelProgressId) {
    return mapChannel(
      store.get(
        `SELECT * FROM history_import_local_channel
         WHERE job_id = ? AND channel_progress_id = ?`,
        requireString(jobId, "jobId"),
        requireString(channelProgressId, "channelProgressId"),
      ),
    );
  }

  function ensureChannel(input) {
    const jobId = requireString(input?.jobId, "jobId");
    const guildId = requireString(input?.guildId, "guildId");
    const channelId = requireString(input?.channelId, "channelId");
    const channelProgressId = requireString(
      input?.channelProgressId ?? input?.id ?? channelId,
      "channelProgressId",
    );
    const at = now();
    store.run(
      `INSERT INTO history_import_local_channel (
         job_id, channel_progress_id, guild_id, channel_id, channel_name,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id, channel_id) DO UPDATE SET
         channel_progress_id = excluded.channel_progress_id,
         channel_name = excluded.channel_name,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      jobId,
      channelProgressId,
      guildId,
      channelId,
      String(input?.channelName ?? channelId).slice(0, 120),
      String(input?.status ?? "pending"),
      at,
      at,
    );
    return getChannel(jobId, channelId);
  }

  function prepareJob(job, channels) {
    return inTransaction(() => {
      ensureJob({ ...job, jobId: job?.id ?? job?.jobId, status: "running" });
      for (const channel of channels) {
        ensureChannel({
          jobId: job?.id ?? job?.jobId,
          guildId: job.guildId,
          channelProgressId: channel.id ?? channel.channelId,
          channelId: channel.channelId,
          channelName: channel.channelName,
          status: channel.status,
        });
      }
      return getJob(job?.id ?? job?.jobId);
    });
  }

  function setJobState(jobId, jobStatus, input = {}) {
    const at = now();
    const normalizedId = requireString(jobId, "jobId");
    store.run(
      `UPDATE history_import_local_job
       SET status = ?,
           current_channel_id = CASE
             WHEN ? THEN ? ELSE current_channel_id END,
           retry_state = CASE WHEN ? THEN ? ELSE retry_state END,
           retry_after_at = CASE WHEN ? THEN ? ELSE retry_after_at END,
           last_heartbeat_at = CASE WHEN ? THEN ? ELSE last_heartbeat_at END,
           updated_at = ?
       WHERE job_id = ?`,
      status(jobStatus),
      Object.hasOwn(input, "currentChannelId") ? 1 : 0,
      optionalString(input.currentChannelId),
      Object.hasOwn(input, "retryState") ? 1 : 0,
      optionalString(input.retryState),
      Object.hasOwn(input, "retryAfterAt") ? 1 : 0,
      input.retryAfterAt == null
        ? null
        : toEpochMilliseconds(input.retryAfterAt, "retryAfterAt"),
      Object.hasOwn(input, "lastHeartbeatAt") ? 1 : 0,
      input.lastHeartbeatAt == null
        ? null
        : toEpochMilliseconds(input.lastHeartbeatAt, "lastHeartbeatAt"),
      at,
      normalizedId,
    );
    return getJob(normalizedId);
  }

  function setChannelState(jobId, channelId, channelStatus, input = {}) {
    const at = now();
    const normalizedJobId = requireString(jobId, "jobId");
    const normalizedChannelId = requireString(channelId, "channelId");
    store.run(
      `UPDATE history_import_local_channel
       SET status = ?,
           retry_count = CASE WHEN ? THEN ? ELSE retry_count END,
           retry_after_at = CASE WHEN ? THEN ? ELSE retry_after_at END,
           failed_count = failed_count + ?,
           last_progress_at = ?,
           updated_at = ?
       WHERE job_id = ? AND channel_id = ?`,
      String(channelStatus),
      Object.hasOwn(input, "retryCount") ? 1 : 0,
      nonNegativeInteger(input.retryCount, "retryCount"),
      Object.hasOwn(input, "retryAfterAt") ? 1 : 0,
      input.retryAfterAt == null
        ? null
        : toEpochMilliseconds(input.retryAfterAt, "retryAfterAt"),
      input.failed ? 1 : 0,
      at,
      at,
      normalizedJobId,
      normalizedChannelId,
    );
    return getChannel(normalizedJobId, normalizedChannelId);
  }

  function getBatch(batchId) {
    return mapBatch(
      store.get(
        "SELECT * FROM history_import_local_batch WHERE batch_id = ?",
        requireString(batchId, "batchId"),
      ),
    );
  }

  function saveBatch(input) {
    const jobId = requireString(input?.jobId, "jobId");
    const guildId = requireString(input?.guildId, "guildId");
    const channelId = requireString(input?.channelId, "channelId");
    const channelProgressId = requireString(
      input?.channelProgressId,
      "channelProgressId",
    );
    const requestBeforeMessageId = optionalString(input?.requestBeforeMessageId);
    const batchId = createStableEventId("history-batch", [
      jobId,
      channelProgressId,
      requestBeforeMessageId ?? "start",
    ]);
    const existing = getBatch(batchId);
    if (existing) {
      return {
        ...existing,
        replayed: true,
        job: getJob(jobId),
        channel: getChannel(jobId, channelId),
      };
    }

    return inTransaction(() => {
      const replay = getBatch(batchId);
      if (replay) {
        return {
          ...replay,
          replayed: true,
          job: getJob(jobId),
          channel: getChannel(jobId, channelId),
        };
      }
      ensureJob({ jobId, guildId, status: "running" });
      ensureChannel({
        jobId,
        guildId,
        channelProgressId,
        channelId,
        channelName: input?.channelName,
        status: "running",
      });
      const at = now();
      const records = Array.isArray(input?.records) ? input.records : [];
      let insertedCount = 0;
      for (const record of records) {
        if (
          String(record?.guildId) !== guildId ||
          String(record?.channelId) !== channelId
        ) {
          throw new Error("History Import batch crossed its Guild or channel boundary.");
        }
        const normalized = sourceRecord(record, at);
        const result = messageDomain.recordEvent(normalized);
        if (result.inserted) {
          insertedCount += 1;
          analyticsProjections.markMessageEvent(result.event, { at });
        }
      }
      const fetchedCount = nonNegativeInteger(input?.fetchedCount, "fetchedCount");
      const eligibleCount = records.length;
      const duplicateCount = eligibleCount - insertedCount;
      store.run(
        `UPDATE history_import_local_channel
         SET fetched_count = fetched_count + ?,
             eligible_count = eligible_count + ?,
             inserted_count = inserted_count + ?,
             duplicate_count = duplicate_count + ?,
             next_before_message_id = ?,
             oldest_message_id = COALESCE(?, oldest_message_id),
             retry_count = 0,
             retry_after_at = NULL,
             last_progress_at = ?,
             updated_at = ?
         WHERE job_id = ? AND channel_id = ?`,
        fetchedCount,
        eligibleCount,
        insertedCount,
        duplicateCount,
        optionalString(input?.nextBeforeMessageId),
        optionalString(input?.oldestMessageId),
        at,
        at,
        jobId,
        channelId,
      );
      store.run(
        `UPDATE history_import_local_job
         SET status = 'running',
             fetched_count = fetched_count + ?,
             eligible_count = eligible_count + ?,
             inserted_count = inserted_count + ?,
             duplicate_count = duplicate_count + ?,
             current_channel_id = ?,
             retry_state = NULL,
             retry_after_at = NULL,
             last_checkpoint_at = ?,
             last_heartbeat_at = ?,
             updated_at = ?
         WHERE job_id = ?`,
        fetchedCount,
        eligibleCount,
        insertedCount,
        duplicateCount,
        channelId,
        at,
        at,
        at,
        jobId,
      );
      store.run(
        `INSERT INTO history_import_local_batch (
           batch_id, job_id, channel_progress_id, guild_id, channel_id,
           request_before_message_id, next_before_message_id,
           oldest_message_id, fetched_count, eligible_count, inserted_count,
           duplicate_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        batchId,
        jobId,
        channelProgressId,
        guildId,
        channelId,
        requestBeforeMessageId,
        optionalString(input?.nextBeforeMessageId),
        optionalString(input?.oldestMessageId),
        fetchedCount,
        eligibleCount,
        insertedCount,
        duplicateCount,
        at,
      );
      return {
        ...getBatch(batchId),
        replayed: false,
        job: getJob(jobId),
        channel: getChannel(jobId, channelId),
      };
    });
  }

  function rebuildDerivedMessageState(guildId, at) {
    store.run("DELETE FROM local_message_daily_stats WHERE guild_id = ?", guildId);
    store.run("DELETE FROM local_message_active_member WHERE guild_id = ?", guildId);
    store.run("DELETE FROM local_message_recent_activity WHERE guild_id = ?", guildId);
    store.run(
      `INSERT INTO local_message_daily_stats (
         guild_id, date_utc, message_count, member_count, updated_at
       )
       SELECT guild_id, date(occurred_at / 1000, 'unixepoch'), COUNT(*), NULL, ?
       FROM message_event_log
       WHERE guild_id = ? AND event_type = 'create'
       GROUP BY guild_id, date(occurred_at / 1000, 'unixepoch')`,
      at,
      guildId,
    );
    store.run(
      `INSERT INTO local_message_active_member (
         guild_id, user_id, date_utc, first_message_at, last_message_at,
         message_count, updated_at
       )
       SELECT guild_id, author_id, date(occurred_at / 1000, 'unixepoch'),
              MIN(occurred_at), MAX(occurred_at), COUNT(*), ?
       FROM message_event_log
       WHERE guild_id = ? AND event_type = 'create' AND author_id IS NOT NULL
       GROUP BY guild_id, author_id, date(occurred_at / 1000, 'unixepoch')`,
      at,
      guildId,
    );
    store.run(
      `INSERT INTO local_message_recent_activity (
         event_id, guild_id, actor_id, actor_name, channel_id, channel_name,
         occurred_at, created_at
       )
       SELECT event_id, guild_id, author_id,
              COALESCE(json_extract(payload_json, '$.authorName'), 'unknown'),
              channel_id, json_extract(payload_json, '$.channelName'),
              occurred_at, ?
       FROM message_event_log
       WHERE guild_id = ? AND event_type = 'create'`,
      at,
      guildId,
    );
  }

  function deleteImportedHistory(input) {
    const requestId = requireString(input?.requestId, "requestId");
    const guildId = requireString(input?.guildId, "guildId");
    const receipt = store.get(
      "SELECT * FROM history_import_local_deletion WHERE request_id = ?",
      requestId,
    );
    if (receipt) {
      return {
        requestId,
        guildId: receipt.guild_id,
        deletedMessages: Number(receipt.deleted_messages),
        deletedAt: Number(receipt.deleted_at),
        replayed: true,
      };
    }
    return inTransaction(() => {
      const replay = store.get(
        "SELECT * FROM history_import_local_deletion WHERE request_id = ?",
        requestId,
      );
      if (replay) {
        return {
          requestId,
          guildId: replay.guild_id,
          deletedMessages: Number(replay.deleted_messages),
          deletedAt: Number(replay.deleted_at),
          replayed: true,
        };
      }
      const at = now();
      const grouped = store.all(
        `SELECT guild_id, channel_id, author_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                MAX(occurred_at) AS source_sequence
         FROM message_event_log
         WHERE guild_id = ? AND source = 'history_import'
           AND event_type = 'create'
         GROUP BY guild_id, channel_id, author_id, date_utc`,
        guildId,
      );
      if (grouped.length > 0) {
        analyticsProjections.markDirty({
          projectionKind: "guild_current",
          guildId,
          sourceSequence: at,
          lastEventAt: at,
        }, { at });
      }
      const guildDates = new Set();
      for (const row of grouped) {
        if (!guildDates.has(row.date_utc)) {
          guildDates.add(row.date_utc);
          analyticsProjections.markDirty({
            projectionKind: "guild_daily",
            guildId,
            dateUtc: row.date_utc,
            sourceSequence: at,
            lastEventAt: at,
          }, { at });
        }
        analyticsProjections.markDirty({
          projectionKind: "channel_daily",
          guildId,
          channelId: row.channel_id,
          dateUtc: row.date_utc,
          sourceSequence: at,
          lastEventAt: at,
        }, { at });
        if (row.author_id) {
          analyticsProjections.markDirty({
            projectionKind: "user_daily",
            guildId,
            userId: row.author_id,
            dateUtc: row.date_utc,
            sourceSequence: at,
            lastEventAt: at,
          }, { at });
        }
      }
      const result = store.run(
        `DELETE FROM local_message_recent_activity
         WHERE event_id IN (
           SELECT event_id FROM message_event_log
           WHERE guild_id = ? AND source = 'history_import'
         )`,
        guildId,
      );
      void result;
      const deletedEvents = store.run(
        `DELETE FROM message_event_log
         WHERE guild_id = ? AND source = 'history_import'`,
        guildId,
      );
      store.run(
        `DELETE FROM message_events
         WHERE guild_id = ? AND source = 'history_import'`,
        guildId,
      );
      rebuildDerivedMessageState(guildId, at);
      const deletedMessages = Number(deletedEvents.changes);
      store.run(
        `INSERT INTO history_import_local_deletion (
           request_id, guild_id, deleted_messages, deleted_at
         ) VALUES (?, ?, ?, ?)`,
        requestId,
        guildId,
        deletedMessages,
        at,
      );
      return {
        requestId,
        guildId,
        deletedMessages,
        deletedAt: at,
        replayed: false,
      };
    });
  }

  function getImportedCount(guildId) {
    const row = store.get(
      `SELECT COUNT(*) AS count FROM message_event_log
       WHERE guild_id = ? AND source = 'history_import'`,
      requireString(guildId, "guildId"),
    );
    return Number(row?.count ?? 0);
  }

  return Object.freeze({
    ensureJob,
    prepareJob,
    ensureChannel,
    setJobState,
    setChannelState,
    saveBatch,
    getJob,
    getChannel,
    getChannelByProgressId,
    getBatch,
    deleteImportedHistory,
    getImportedCount,
  });
}
