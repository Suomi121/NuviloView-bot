import {
  MESSAGE_IMPORT_STATUS,
  MESSAGE_SOURCE,
  classifyImportError,
  withBoundedImportRetry,
} from "./message-history-import.mjs";

function rowsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function safeCounts(value = {}) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, count]) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key) && Number.isFinite(Number(count)))
      .map(([key, count]) => [key, Math.max(0, Math.trunc(Number(count)))]),
  );
}

export function messageBatchRecords(messages, { guildId, channelId, channelName, jobId, roleIdsForMessage = () => [] }) {
  const records = [];
  for (const message of messages) {
    if (!message?.id || message.author?.bot || !message.content?.trim()) continue;
    records.push({
      id: String(message.id),
      guildId: String(guildId),
      channelId: String(channelId),
      channelName: String(channelName).slice(0, 120),
      authorId: String(message.author.id),
      authorName: String(message.member?.displayName ?? message.author.username ?? "Unknown").slice(0, 120),
      authorIsBot: false,
      authorRoleIds: roleIdsForMessage(message),
      content: String(message.content),
      createdAt: new Date(message.createdAt).toISOString(),
      source: MESSAGE_SOURCE.history,
      importJobId: Number(jobId),
    });
  }
  return records;
}

export function createMessageHistoryImportRepository(query) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");

  async function syncJobCounts(jobId) {
    const result = await query(`
      UPDATE "history_import_job" AS job
      SET "totalChannels" = counts.total,
          "completedChannels" = counts.completed,
          "failedChannels" = counts.failed,
          "skippedChannels" = counts.skipped,
          "updatedAt" = CURRENT_TIMESTAMP,
          "lastDbWriteAt" = CURRENT_TIMESTAMP
      FROM (
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE "status" = 'completed')::int AS completed,
          count(*) FILTER (WHERE "status" = 'failed')::int AS failed,
          count(*) FILTER (WHERE "status" = 'skipped')::int AS skipped
        FROM "history_import_channel_progress"
        WHERE "jobId" = $1
      ) AS counts
      WHERE job."id" = $1
      RETURNING job.*
    `, [jobId]);
    return rowsFromResult(result)[0] ?? null;
  }

  return Object.freeze({
    async recoverStale(stallSeconds) {
      const result = await query(`
        UPDATE "history_import_job"
        SET "status" = 'stalled',
            "safeErrorCode" = CASE WHEN "version" < 2 THEN 'LEGACY_IMPORT_STALLED' ELSE 'WORKER_HEARTBEAT_STALE' END,
            "safeErrorSummary" = CASE WHEN "version" < 2
              THEN '旧形式の取り込みが中断されています。状態をリセットして新しい取り込みを開始してください。'
              ELSE '取り込みWorkerの応答が途絶えました。再開・キャンセル・状態リセットを選択できます。' END,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "status" IN ('preparing', 'running', 'pausing', 'cancelling')
          AND ("retryAfterAt" IS NULL OR "retryAfterAt" <= CURRENT_TIMESTAMP)
          AND COALESCE("lastWorkerHeartbeatAt", "lastProgressAt", "startedAt", "requestedAt")
            < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')
        RETURNING "id", "guildId", "version"
      `, [stallSeconds]);
      return rowsFromResult(result);
    },

    async claimNext({ hostId, instanceId }) {
      const result = await query(`
        WITH candidate AS (
          SELECT "id"
          FROM "history_import_job"
          WHERE "version" = 2 AND "status" = 'queued' AND "cancelRequested" = false
          ORDER BY "requestedAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "history_import_job" AS job
        SET "status" = 'preparing',
            "startedAt" = COALESCE(job."startedAt", CURRENT_TIMESTAMP),
            "updatedAt" = CURRENT_TIMESTAMP,
            "lastProgressAt" = COALESCE(job."lastProgressAt", CURRENT_TIMESTAMP),
            "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP,
            "workerHostId" = $1,
            "workerInstanceId" = $2,
            "safeErrorCode" = NULL,
            "safeErrorSummary" = NULL,
            "retryState" = NULL,
            "retryAfterAt" = NULL
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job.*
      `, [hostId, instanceId]);
      return rowsFromResult(result)[0] ?? null;
    },

    async prepareChannels(job, channels) {
      if (channels.length > 0) {
        await query(`
          INSERT INTO "history_import_channel_progress" (
            "jobId", "guildId", "channelId", "channelName", "status", "skipReason",
            "lastProgressAt", "updatedAt"
          )
          SELECT $1, $2, input."channelId", input."channelName", input."status", input."skipReason",
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          FROM jsonb_to_recordset($3::jsonb) AS input(
            "channelId" text, "channelName" text, "status" text, "skipReason" text
          )
          ON CONFLICT ("jobId", "channelId") DO NOTHING
        `, [job.id, job.guildId, JSON.stringify(channels)]);
      }
      await syncJobCounts(job.id);
      const result = await query(`
        UPDATE "history_import_job"
        SET "status" = CASE WHEN "cancelRequested" THEN 'cancelling' WHEN "pauseRequested" THEN 'pausing' ELSE 'running' END,
            "updatedAt" = CURRENT_TIMESTAMP,
            "lastProgressAt" = CURRENT_TIMESTAMP,
            "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" = 'preparing'
        RETURNING *
      `, [job.id]);
      return rowsFromResult(result)[0] ?? null;
    },

    async heartbeat(jobId) {
      await query(`
        UPDATE "history_import_job"
        SET "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" IN ('preparing', 'running', 'pausing', 'cancelling')
      `, [jobId]);
    },

    async control(jobId, channelProgressId = null) {
      const result = await query(`
        SELECT job."status", job."cancelRequested", job."pauseRequested", job."retryAfterAt",
               COALESCE(channel."skipRequested", false) AS "skipRequested"
        FROM "history_import_job" AS job
        LEFT JOIN "history_import_channel_progress" AS channel
          ON channel."id" = $2 AND channel."jobId" = job."id"
        WHERE job."id" = $1
        LIMIT 1
      `, [jobId, channelProgressId]);
      return rowsFromResult(result)[0] ?? null;
    },

    async nextChannel(jobId) {
      const result = await query(`
        WITH candidate AS (
          SELECT "id"
          FROM "history_import_channel_progress"
          WHERE "jobId" = $1 AND "status" = 'pending'
          ORDER BY "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "history_import_channel_progress" AS channel
        SET "status" = 'running',
            "startedAt" = COALESCE(channel."startedAt", CURRENT_TIMESTAMP),
            "updatedAt" = CURRENT_TIMESTAMP,
            "lastProgressAt" = COALESCE(channel."lastProgressAt", CURRENT_TIMESTAMP),
            "safeErrorCode" = NULL,
            "safeErrorSummary" = NULL,
            "retryAfterAt" = NULL
        FROM candidate
        WHERE channel."id" = candidate."id"
        RETURNING channel.*
      `, [jobId]);
      const channel = rowsFromResult(result)[0] ?? null;
      if (channel) {
        await query(`
          UPDATE "history_import_job"
          SET "currentChannelId" = $2, "updatedAt" = CURRENT_TIMESTAMP, "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1
        `, [jobId, channel.channelId]);
      }
      return channel;
    },

    async saveBatch({ jobId, channelProgressId, records, fetchedCount, nextBeforeMessageId, oldestMessageId }) {
      const result = await query(`
        WITH gate AS (
          SELECT "id" FROM "history_import_channel_progress"
          WHERE "id" = $2 AND "jobId" = $1 AND "status" = 'running'
        ), input AS (
          SELECT * FROM jsonb_to_recordset($3::jsonb) AS message(
            "id" text, "guildId" text, "channelId" text, "channelName" text,
            "authorId" text, "authorName" text, "authorIsBot" boolean,
            "authorRoleIds" jsonb, "content" text, "createdAt" timestamptz,
            "source" text, "importJobId" integer
          )
        ), inserted AS (
          INSERT INTO "discord_message" (
            "id", "guildId", "channelId", "channelName", "authorId", "authorName",
            "authorIsBot", "authorRoleIds", "content", "source", "importJobId", "createdAt", "updatedAt"
          )
          SELECT input."id", input."guildId", input."channelId", input."channelName",
                 input."authorId", input."authorName", input."authorIsBot", input."authorRoleIds",
                 input."content", input."source", input."importJobId", input."createdAt", CURRENT_TIMESTAMP
          FROM input CROSS JOIN gate
          ON CONFLICT ("id") DO NOTHING
          RETURNING "id"
        ), counts AS (
          SELECT (SELECT count(*) FROM input)::int AS eligible,
                 (SELECT count(*) FROM inserted)::int AS inserted
        ), channel_update AS (
          UPDATE "history_import_channel_progress" AS channel
          SET "fetchedCount" = channel."fetchedCount" + $4,
              "insertedCount" = channel."insertedCount" + counts.inserted,
              "duplicateCount" = channel."duplicateCount" + (counts.eligible - counts.inserted),
              "nextBeforeMessageId" = $5,
              "oldestMessageId" = COALESCE($6, channel."oldestMessageId"),
              "lastApiResponseAt" = CURRENT_TIMESTAMP,
              "lastDbWriteAt" = CURRENT_TIMESTAMP,
              "lastProgressAt" = CURRENT_TIMESTAMP,
              "updatedAt" = CURRENT_TIMESTAMP,
              "retryAfterAt" = NULL,
              "safeErrorCode" = NULL,
              "safeErrorSummary" = NULL
          FROM counts, gate
          WHERE channel."id" = gate."id"
          RETURNING counts.eligible, counts.inserted
        )
        UPDATE "history_import_job" AS job
        SET "processedMessages" = job."processedMessages" + channel_update.eligible,
            "fetchedMessages" = job."fetchedMessages" + $4,
            "insertedMessages" = job."insertedMessages" + channel_update.inserted,
            "duplicateMessages" = job."duplicateMessages" + (channel_update.eligible - channel_update.inserted),
            "lastApiResponseAt" = CURRENT_TIMESTAMP,
            "lastDbWriteAt" = CURRENT_TIMESTAMP,
            "lastProgressAt" = CURRENT_TIMESTAMP,
            "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP,
            "retryState" = NULL,
            "retryAfterAt" = NULL
        FROM channel_update
        WHERE job."id" = $1
        RETURNING job.*, channel_update.eligible AS "batchEligible", channel_update.inserted AS "batchInserted"
      `, [jobId, channelProgressId, JSON.stringify(records), fetchedCount, nextBeforeMessageId, oldestMessageId]);
      return rowsFromResult(result)[0] ?? null;
    },

    async setRetry({ jobId, channelProgressId, retries, retryAfter, safe }) {
      await query(`
        UPDATE "history_import_channel_progress"
        SET "retryCount" = $3, "retryAfterAt" = $4, "safeErrorCode" = $5,
            "safeErrorSummary" = $6, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $2 AND "jobId" = $1
      `, [jobId, channelProgressId, retries, retryAfter, safe.code, safe.summary]);
      await query(`
        UPDATE "history_import_job"
        SET "retryState" = $2, "retryAfterAt" = $3, "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, [jobId, safe.code, retryAfter]);
    },

    async settleChannel(jobId, channelProgressId, status, safe = null) {
      await query(`
        UPDATE "history_import_channel_progress"
        SET "status" = $3,
            "completedAt" = CASE WHEN $3 IN ('completed', 'failed', 'skipped', 'cancelled') THEN CURRENT_TIMESTAMP ELSE "completedAt" END,
            "safeErrorCode" = $4,
            "safeErrorSummary" = $5,
            "skipRequested" = false,
            "retryAfterAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $2 AND "jobId" = $1
      `, [jobId, channelProgressId, status, safe?.code ?? null, safe?.summary ?? null]);
      return syncJobCounts(jobId);
    },

    async pause(jobId, channelProgressId = null) {
      if (channelProgressId) await this.settleChannel(jobId, channelProgressId, "paused");
      const result = await query(`
        UPDATE "history_import_job"
        SET "status" = 'paused', "pauseRequested" = false, "pausedAt" = CURRENT_TIMESTAMP,
            "currentChannelId" = NULL, "retryState" = NULL, "retryAfterAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP, "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" IN ('preparing', 'running', 'pausing')
        RETURNING *
      `, [jobId]);
      return rowsFromResult(result)[0] ?? null;
    },

    async cancel(jobId, channelProgressId = null) {
      if (channelProgressId) await this.settleChannel(jobId, channelProgressId, "cancelled");
      const result = await query(`
        UPDATE "history_import_job"
        SET "status" = 'cancelled', "cancelRequested" = false, "pauseRequested" = false,
            "cancelledAt" = CURRENT_TIMESTAMP, "completedAt" = CURRENT_TIMESTAMP,
            "currentChannelId" = NULL, "retryState" = NULL, "retryAfterAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP, "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" IN ('queued', 'preparing', 'running', 'pausing', 'paused', 'cancelling', 'stalled')
        RETURNING *
      `, [jobId]);
      return rowsFromResult(result)[0] ?? null;
    },

    async complete(jobId) {
      await syncJobCounts(jobId);
      const result = await query(`
        UPDATE "history_import_job"
        SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP, "currentChannelId" = NULL,
            "safeErrorCode" = CASE WHEN "failedChannels" > 0 THEN 'COMPLETED_WITH_WARNINGS' ELSE NULL END,
            "safeErrorSummary" = CASE WHEN "failedChannels" > 0 THEN '一部のチャンネルを取り込めませんでした。' ELSE NULL END,
            "retryState" = NULL, "retryAfterAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP,
            "lastProgressAt" = CURRENT_TIMESTAMP, "lastWorkerHeartbeatAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" IN ('preparing', 'running')
        RETURNING *
      `, [jobId]);
      return rowsFromResult(result)[0] ?? null;
    },

    async fail(jobId, safe) {
      const result = await query(`
        UPDATE "history_import_job"
        SET "status" = 'failed', "failedAt" = CURRENT_TIMESTAMP, "completedAt" = CURRENT_TIMESTAMP,
            "currentChannelId" = NULL, "safeErrorCode" = $2, "safeErrorSummary" = $3,
            "retryState" = NULL, "retryAfterAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" NOT IN ('cancelled', 'completed', 'failed')
        RETURNING *
      `, [jobId, safe.code, safe.summary]);
      return rowsFromResult(result)[0] ?? null;
    },

    async audit({ jobId = null, guildId, channelId = null, eventType, actorId = null, counts = {}, safeErrorCode = null }) {
      await query(`
        INSERT INTO "message_import_audit_event" (
          "jobId", "guildId", "channelId", "eventType", "actorId", "counts", "safeErrorCode"
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      `, [jobId, guildId, channelId, eventType, actorId, JSON.stringify(safeCounts(counts)), safeErrorCode]);
    },
  });
}

export function createMessageHistoryImportWorker({
  repository,
  discordClient,
  config,
  identity,
  isGuildBlocked = () => false,
  roleIdsForMessage = () => [],
  logger = console,
  sleep,
}) {
  if (!repository || !discordClient) throw new TypeError("Repository and Discord client are required.");
  let processing = false;

  async function audit(event) {
    await repository.audit(event).catch((error) => logger.warn("Message import audit write failed", { code: classifyImportError(error).code }));
    logger.info(`[MessageImport] ${event.eventType}`, {
      jobId: event.jobId,
      guildId: event.guildId,
      channelId: event.channelId ?? null,
      counts: safeCounts(event.counts),
      safeErrorCode: event.safeErrorCode ?? null,
    });
  }

  async function controlAtBoundary(job, channel = null) {
    const control = await repository.control(job.id, channel?.id ?? null);
    if (!control) return "missing";
    if (control.cancelRequested || control.status === MESSAGE_IMPORT_STATUS.cancelling) {
      await repository.cancel(job.id, channel?.id ?? null);
      await audit({ jobId: job.id, guildId: job.guildId, channelId: channel?.channelId, eventType: "IMPORT_JOB_CANCELLED" });
      return "cancelled";
    }
    if (control.pauseRequested || control.status === MESSAGE_IMPORT_STATUS.pausing) {
      await repository.pause(job.id, channel?.id ?? null);
      await audit({ jobId: job.id, guildId: job.guildId, channelId: channel?.channelId, eventType: "IMPORT_JOB_PAUSED" });
      return "paused";
    }
    if (channel && control.skipRequested) {
      await repository.settleChannel(job.id, channel.id, "skipped", { code: "USER_SKIPPED", summary: "管理者がこのチャンネルをスキップしました。" });
      await audit({ jobId: job.id, guildId: job.guildId, channelId: channel.channelId, eventType: "IMPORT_CHANNEL_SKIPPED" });
      return "skipped";
    }
    return "continue";
  }

  async function processChannel(job, channelProgress, discordChannel, cutoff) {
    await audit({ jobId: job.id, guildId: job.guildId, channelId: channelProgress.channelId, eventType: "IMPORT_CHANNEL_STARTED" });
    let before = channelProgress.nextBeforeMessageId || undefined;
    let pages = 0;
    try {
      while (pages < config.maxPagesPerChannel) {
        await repository.heartbeat(job.id);
        const beforeBoundary = await controlAtBoundary(job, channelProgress);
        if (beforeBoundary !== "continue") return beforeBoundary;

        const messages = await withBoundedImportRetry(
          () => discordChannel.messages.fetch({ limit: config.batchSize, ...(before ? { before } : {}) }),
          {
            maxRetries: config.maxRetries,
            sleep,
            onRetry: async ({ retries, delayMs, safe }) => {
              const retryAfter = new Date(Date.now() + delayMs);
              await repository.setRetry({ jobId: job.id, channelProgressId: channelProgress.id, retries, retryAfter, safe });
            },
          },
        );
        pages += 1;
        if (messages.size === 0) {
          await repository.settleChannel(job.id, channelProgress.id, "completed");
          await audit({ jobId: job.id, guildId: job.guildId, channelId: channelProgress.channelId, eventType: "IMPORT_CHANNEL_COMPLETED", counts: { pages } });
          return "completed";
        }

        const values = [...messages.values()];
        const withinCutoff = values.filter((message) => message.createdAt >= cutoff);
        const reachedCutoff = withinCutoff.length !== values.length;
        const nextBefore = messages.last()?.id ?? null;
        if (before && nextBefore === before) {
          const paginationError = new Error("Discord pagination did not advance.");
          paginationError.code = "PAGINATION_STALLED";
          throw paginationError;
        }
        const records = messageBatchRecords(withinCutoff, {
          guildId: job.guildId,
          channelId: channelProgress.channelId,
          channelName: channelProgress.channelName,
          jobId: job.id,
          roleIdsForMessage,
        });

        await withBoundedImportRetry(
          () => repository.saveBatch({
            jobId: job.id,
            channelProgressId: channelProgress.id,
            records,
            fetchedCount: messages.size,
            nextBeforeMessageId: nextBefore,
            oldestMessageId: nextBefore,
          }),
          {
            maxRetries: config.maxRetries,
            sleep,
            onRetry: async ({ retries, delayMs, safe }) => {
              const retryAfter = new Date(Date.now() + delayMs);
              await repository.setRetry({ jobId: job.id, channelProgressId: channelProgress.id, retries, retryAfter, safe }).catch(() => {});
            },
          },
        );

        const afterBoundary = await controlAtBoundary(job, channelProgress);
        if (afterBoundary !== "continue") return afterBoundary;
        if (reachedCutoff || messages.size < config.batchSize || !nextBefore) {
          await repository.settleChannel(job.id, channelProgress.id, "completed");
          await audit({ jobId: job.id, guildId: job.guildId, channelId: channelProgress.channelId, eventType: "IMPORT_CHANNEL_COMPLETED", counts: { pages } });
          return "completed";
        }
        before = nextBefore;
      }
      const paginationLimit = { code: "PAGINATION_LIMIT", summary: "安全上限に達したため、このチャンネルの取り込みを停止しました。" };
      await repository.settleChannel(job.id, channelProgress.id, "failed", paginationLimit);
      await audit({ jobId: job.id, guildId: job.guildId, channelId: channelProgress.channelId, eventType: "IMPORT_CHANNEL_FAILED", counts: { pages }, safeErrorCode: paginationLimit.code });
      return "failed";
    } catch (error) {
      const safe = error?.safeImport ?? classifyImportError(error);
      await repository.settleChannel(job.id, channelProgress.id, "failed", safe);
      await audit({ jobId: job.id, guildId: job.guildId, channelId: channelProgress.channelId, eventType: "IMPORT_CHANNEL_FAILED", counts: { pages }, safeErrorCode: safe.code });
      return "failed";
    }
  }

  async function processJob(job) {
    try {
      if (isGuildBlocked(job.guildId)) {
        await repository.cancel(job.id);
        await audit({ jobId: job.id, guildId: job.guildId, eventType: "IMPORT_JOB_CANCELLED", safeErrorCode: "GUILD_BLOCKED" });
        return;
      }
      const guild = discordClient.guilds.cache.get(job.guildId) ?? await discordClient.guilds.fetch(job.guildId);
      if (!guild) throw Object.assign(new Error("Guild unavailable"), { code: "GUILD_UNAVAILABLE" });
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      const fetchedChannels = await guild.channels.fetch();
      const channels = [...fetchedChannels.values()]
        .filter((channel) => channel?.isTextBased?.() && "messages" in channel)
        .map((channel) => {
          const permissions = channel.permissionsFor(botMember);
          const canView = permissions?.has("ViewChannel") === true;
          const canReadHistory = permissions?.has("ReadMessageHistory") === true;
          const accessible = canView && canReadHistory;
          return {
            channelId: channel.id,
            channelName: String(channel.name ?? channel.id).slice(0, 120),
            status: accessible ? "pending" : "skipped",
            skipReason: accessible ? null : !canView ? "MISSING_VIEW_CHANNEL" : "MISSING_READ_MESSAGE_HISTORY",
          };
        });
      await repository.prepareChannels(job, channels);
      await audit({ jobId: job.id, guildId: job.guildId, eventType: "IMPORT_JOB_STARTED", counts: { totalChannels: channels.length, skippedChannels: channels.filter((channel) => channel.status === "skipped").length } });

      const initialControl = await controlAtBoundary(job);
      if (initialControl !== "continue") return;
      const cutoff = job.days === 0 ? new Date(0) : new Date(Date.now() - job.days * 86_400_000);
      while (true) {
        const boundary = await controlAtBoundary(job);
        if (boundary !== "continue") return;
        const channelProgress = await repository.nextChannel(job.id);
        if (!channelProgress) break;
        const channel = fetchedChannels.get(channelProgress.channelId)
          ?? await guild.channels.fetch(channelProgress.channelId).catch(() => null);
        if (!channel || !("messages" in channel)) {
          const safe = { code: "CHANNEL_UNAVAILABLE", summary: "チャンネルを取得できませんでした。" };
          await repository.settleChannel(job.id, channelProgress.id, "failed", safe);
          await audit({ jobId: job.id, guildId: job.guildId, channelId: channelProgress.channelId, eventType: "IMPORT_CHANNEL_FAILED", safeErrorCode: safe.code });
          continue;
        }
        const outcome = await processChannel(job, channelProgress, channel, cutoff);
        if (outcome === "paused" || outcome === "cancelled" || outcome === "missing") return;
      }
      const completed = await repository.complete(job.id);
      await audit({
        jobId: job.id,
        guildId: job.guildId,
        eventType: "IMPORT_JOB_COMPLETED",
        counts: {
          fetchedMessages: completed?.fetchedMessages,
          insertedMessages: completed?.insertedMessages,
          duplicateMessages: completed?.duplicateMessages,
          failedChannels: completed?.failedChannels,
        },
        safeErrorCode: completed?.safeErrorCode,
      });
    } catch (error) {
      const safe = error?.safeImport ?? classifyImportError(error);
      await repository.fail(job.id, safe).catch(() => {});
      await audit({ jobId: job.id, guildId: job.guildId, eventType: "IMPORT_JOB_FAILED", safeErrorCode: safe.code });
    }
  }

  return Object.freeze({
    async recoverStaleJobs() {
      if (!config.enabled) return [];
      const recovered = await repository.recoverStale(config.stallSeconds);
      for (const job of recovered) {
        await audit({ jobId: job.id, guildId: job.guildId, eventType: "IMPORT_JOB_STALLED", safeErrorCode: job.version < 2 ? "LEGACY_IMPORT_STALLED" : "WORKER_HEARTBEAT_STALE" });
      }
      return recovered;
    },

    async poll() {
      if (!config.enabled || processing) return null;
      processing = true;
      try {
        await this.recoverStaleJobs();
        const job = await repository.claimNext(identity);
        if (!job) return null;
        await processJob(job);
        return job.id;
      } finally {
        processing = false;
      }
    },

    get processing() {
      return processing;
    },
  });
}
