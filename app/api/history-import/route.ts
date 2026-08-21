import type { PoolClient } from "pg";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getManagedGuilds } from "@/lib/discord";
import {
  getMessageImportConfig,
  isDiscordSnowflake,
  parseImportedDataDeletion,
  parseMessageImportMutation,
} from "@/lib/message-history-import.mjs";
import {
  hasJsonBody,
  isRateLimited,
  isTrustedMutation,
} from "@/lib/request-security";

const messageImportConfig = getMessageImportConfig(process.env);
const activeWorkerStatuses = new Set(["preparing", "running", "pausing", "cancelling"]);
type ImportMutationInput = {
  action: string;
  guildId: string;
  jobId?: number;
  channelId?: string;
  days?: number;
  mode?: string;
};

async function mayManageGuild(userId: string, guildId: string) {
  const guilds = await getManagedGuilds(userId);
  return guilds.some((guild) => guild.id === guildId);
}

function invalidRequest(message = "Invalid request", status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function authorizeGuildRequest(request: Request, guildId: string) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { response: invalidRequest("Unauthorized", 401) };
  if (!isDiscordSnowflake(guildId)) return { response: invalidRequest("Invalid guildId") };
  if (!(await mayManageGuild(session.user.id, guildId))) {
    return { response: invalidRequest("Forbidden", 403) };
  }
  return { userId: session.user.id };
}

async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function writeAudit(
  client: PoolClient,
  input: {
    jobId?: number | null;
    guildId: string;
    channelId?: string | null;
    eventType: string;
    actorId: string;
    counts?: Record<string, number>;
    safeErrorCode?: string | null;
  },
) {
  await client.query(
    `INSERT INTO "message_import_audit_event"
      ("jobId", "guildId", "channelId", "eventType", "actorId", "counts", "safeErrorCode")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.jobId ?? null,
      input.guildId,
      input.channelId ?? null,
      input.eventType,
      input.actorId,
      JSON.stringify(input.counts ?? {}),
      input.safeErrorCode ?? null,
    ],
  );
}

async function loadJobForUpdate(client: PoolClient, guildId: string, jobId: number) {
  const result = await client.query(
    `SELECT * FROM "history_import_job"
     WHERE "id" = $1 AND "guildId" = $2
     FOR UPDATE`,
    [jobId, guildId],
  );
  return result.rows[0] ?? null;
}

async function syncChannelCounts(client: PoolClient, jobId: number) {
  await client.query(
    `UPDATE "history_import_job" AS job
     SET "totalChannels" = counts.total,
         "completedChannels" = counts.completed,
         "failedChannels" = counts.failed,
         "skippedChannels" = counts.skipped,
         "updatedAt" = CURRENT_TIMESTAMP,
         "lastDbWriteAt" = CURRENT_TIMESTAMP
     FROM (
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE "status" = 'completed')::int AS completed,
              count(*) FILTER (WHERE "status" = 'failed')::int AS failed,
              count(*) FILTER (WHERE "status" = 'skipped')::int AS skipped
       FROM "history_import_channel_progress"
       WHERE "jobId" = $1
     ) AS counts
     WHERE job."id" = $1`,
    [jobId],
  );
}

function safeJobSelect() {
  return `"id", "guildId", "requestedBy", "days", "mode", "version", "source", "status",
    "processedMessages", "failedChannels", "totalChannels", "completedChannels", "skippedChannels",
    "estimatedMessages", "fetchedMessages", "insertedMessages", "duplicateMessages", "failedMessages",
    "currentChannelId", "cancelRequested", "pauseRequested", "safeErrorCode", "safeErrorSummary",
    "retryState", "retryAfterAt", "lastApiResponseAt", "lastDbWriteAt", "lastProgressAt",
    "lastWorkerHeartbeatAt", "requestedAt", "startedAt", "pausedAt", "cancelledAt", "failedAt",
    "completedAt", "updatedAt", "resetAt", "resetBy"`;
}

export async function GET(request: Request) {
  const guildId = new URL(request.url).searchParams.get("guildId") ?? "";
  const authorization = await authorizeGuildRequest(request, guildId);
  if (authorization.response) return authorization.response;

  if (!messageImportConfig.enabled) {
    const result = await pool.query(
      `SELECT "id", "days", "mode", "status", "processedMessages", "failedChannels", "requestedAt", "startedAt", "completedAt", "error"
       FROM "history_import_job" WHERE "guildId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`,
      [guildId],
    );
    const job = result.rows[0] ?? null;
    if (job?.error) job.error = "Import failed. Please try again.";
    return NextResponse.json({ featureEnabled: false, job });
  }

  try {
    const [latestResult, historyResult, accessResult, importedDataResult] = await Promise.all([
      pool.query(
        `SELECT ${safeJobSelect()} FROM "history_import_job"
         WHERE "guildId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`,
        [guildId],
      ),
      pool.query(
        `SELECT ${safeJobSelect()} FROM "history_import_job"
         WHERE "guildId" = $1 ORDER BY "requestedAt" DESC LIMIT 20`,
        [guildId],
      ),
      pool.query(
        `SELECT "channelId", "channelName", "canRead", "checkedAt"
         FROM "bot_channel_access" WHERE "guildId" = $1
         ORDER BY "canRead" ASC, "channelName" ASC LIMIT 500`,
        [guildId],
      ),
      pool.query(
        `SELECT count(*)::int AS count FROM "discord_message"
         WHERE "guildId" = $1 AND "source" = 'history_import'`,
        [guildId],
      ),
    ]);
    const job = latestResult.rows[0] ?? null;
    const channels = job
      ? (await pool.query(
        `SELECT "id", "jobId", "channelId", "channelName", "status", "skipReason",
                "fetchedCount", "insertedCount", "duplicateCount", "failedCount", "retryCount",
                "retryAfterAt", "lastApiResponseAt", "lastDbWriteAt", "lastProgressAt", "startedAt",
                "completedAt", "updatedAt", "safeErrorCode", "safeErrorSummary"
         FROM "history_import_channel_progress"
         WHERE "jobId" = $1 AND "guildId" = $2 ORDER BY "id" ASC LIMIT 500`,
        [job.id, guildId],
      )).rows
      : [];
    const accessible = accessResult.rows.filter((channel) => channel.canRead).length;
    return NextResponse.json({
      featureEnabled: true,
      job,
      channels,
      history: historyResult.rows,
      permissionPreview: {
        channels: accessResult.rows.map((channel) => ({
          ...channel,
          skipReason: channel.canRead ? null : "MISSING_VIEW_OR_READ_MESSAGE_HISTORY",
        })),
        accessible,
        skipped: accessResult.rows.length - accessible,
        checkedAt: accessResult.rows[0]?.checkedAt ?? null,
      },
      importedDataCount: importedDataResult.rows[0]?.count ?? 0,
      diagnostics: {
        discordApi: job?.lastApiResponseAt ? "healthy" : "waiting",
        database: job?.lastDbWriteAt ? "healthy" : "waiting",
        worker: !job
          ? "idle"
          : job.status === "stalled"
            ? "stalled"
            : activeWorkerStatuses.has(job.status)
              ? "running"
              : "idle",
        lastApiResponseAt: job?.lastApiResponseAt ?? null,
        lastDbWriteAt: job?.lastDbWriteAt ?? null,
        lastProgressAt: job?.lastProgressAt ?? null,
        lastWorkerHeartbeatAt: job?.lastWorkerHeartbeatAt ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to read Message History Import v2 state:", error);
    return invalidRequest("Unable to load import state", 500);
  }
}

async function createLegacyJob(guildId: string, userId: string, days: number, mode: string) {
  const result = await pool.query(
    `INSERT INTO "history_import_job" ("guildId", "requestedBy", "days", "mode")
     VALUES ($1, $2, $3, $4)
     RETURNING "id", "days", "mode", "status", "processedMessages", "failedChannels", "requestedAt"`,
    [guildId, userId, days, mode],
  );
  return result.rows[0];
}

async function mutateV2Job(
  input: { action: string; guildId: string; jobId?: number; channelId?: string; days?: number; mode?: string },
  userId: string,
) {
  return withTransaction(async (client) => {
    if (input.action === "start") {
      const result = await client.query(
        `INSERT INTO "history_import_job"
          ("guildId", "requestedBy", "days", "mode", "version", "source", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 2, 'history_import', 'queued', CURRENT_TIMESTAMP)
         RETURNING ${safeJobSelect()}`,
        [input.guildId, userId, input.days, input.mode],
      );
      const job = result.rows[0];
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, eventType: "IMPORT_JOB_QUEUED", actorId: userId });
      return job;
    }

    const job = await loadJobForUpdate(client, input.guildId, input.jobId as number);
    if (!job) throw Object.assign(new Error("Import job not found"), { status: 404, safeMessage: "Import job not found" });

    if (input.action === "pause") {
      if (job.status === "paused" || job.status === "pausing") return job;
      if (!["queued", "preparing", "running"].includes(job.status)) {
        throw Object.assign(new Error("Job cannot be paused"), { status: 409, safeMessage: "This import cannot be paused" });
      }
      const result = await client.query(
        `UPDATE "history_import_job"
         SET "status" = CASE WHEN "status" = 'queued' THEN 'paused' ELSE 'pausing' END,
             "pauseRequested" = CASE WHEN "status" = 'queued' THEN false ELSE true END,
             "pausedAt" = CASE WHEN "status" = 'queued' THEN CURRENT_TIMESTAMP ELSE "pausedAt" END,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "guildId" = $2 RETURNING ${safeJobSelect()}`,
        [job.id, input.guildId],
      );
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, eventType: "IMPORT_PAUSE_REQUESTED", actorId: userId });
      return result.rows[0];
    }

    if (input.action === "resume") {
      if (!["paused", "stalled"].includes(job.status)) {
        throw Object.assign(new Error("Job cannot be resumed"), { status: 409, safeMessage: "This import cannot be resumed" });
      }
      await client.query(
        `UPDATE "history_import_channel_progress"
         SET "status" = 'pending', "skipRequested" = false, "retryAfterAt" = NULL,
             "safeErrorCode" = NULL, "safeErrorSummary" = NULL, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "jobId" = $1 AND "guildId" = $2 AND "status" IN ('running', 'paused')`,
        [job.id, input.guildId],
      );
      const result = await client.query(
        `UPDATE "history_import_job"
         SET "status" = 'queued', "pauseRequested" = false, "cancelRequested" = false,
             "pausedAt" = NULL, "currentChannelId" = NULL, "retryState" = NULL,
             "retryAfterAt" = NULL, "safeErrorCode" = NULL, "safeErrorSummary" = NULL,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "guildId" = $2 RETURNING ${safeJobSelect()}`,
        [job.id, input.guildId],
      );
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, eventType: "IMPORT_JOB_RESUMED", actorId: userId });
      return result.rows[0];
    }

    if (input.action === "cancel") {
      if (job.status === "cancelled") return job;
      if (["completed", "failed"].includes(job.status)) {
        throw Object.assign(new Error("Job is already terminal"), { status: 409, safeMessage: "This import has already finished" });
      }
      const immediate = ["queued", "paused", "stalled"].includes(job.status);
      if (immediate) {
        await client.query(
          `UPDATE "history_import_channel_progress"
           SET "status" = 'cancelled', "completedAt" = CURRENT_TIMESTAMP, "skipRequested" = false,
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "jobId" = $1 AND "guildId" = $2 AND "status" IN ('pending', 'running', 'paused')`,
          [job.id, input.guildId],
        );
      }
      const result = await client.query(
        `UPDATE "history_import_job"
         SET "status" = CASE WHEN $3 THEN 'cancelled' ELSE 'cancelling' END,
             "cancelRequested" = CASE WHEN $3 THEN false ELSE true END,
             "pauseRequested" = false,
             "cancelledAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "cancelledAt" END,
             "completedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "completedAt" END,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "guildId" = $2 RETURNING ${safeJobSelect()}`,
        [job.id, input.guildId, immediate],
      );
      await syncChannelCounts(client, job.id);
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, eventType: immediate ? "IMPORT_JOB_CANCELLED" : "IMPORT_CANCEL_REQUESTED", actorId: userId });
      return result.rows[0];
    }

    if (input.action === "reset") {
      if (activeWorkerStatuses.has(job.status)) {
        throw Object.assign(new Error("Running job cannot be reset"), { status: 409, safeMessage: "Cancel the running import before resetting its state" });
      }
      await client.query(
        `DELETE FROM "history_import_channel_progress" WHERE "jobId" = $1 AND "guildId" = $2`,
        [job.id, input.guildId],
      );
      const result = await client.query(
        `UPDATE "history_import_job"
         SET "status" = 'cancelled', "processedMessages" = 0, "failedChannels" = 0,
             "totalChannels" = 0, "completedChannels" = 0, "skippedChannels" = 0,
             "estimatedMessages" = NULL, "fetchedMessages" = 0, "insertedMessages" = 0,
             "duplicateMessages" = 0, "failedMessages" = 0, "currentChannelId" = NULL,
             "cancelRequested" = false, "pauseRequested" = false, "safeErrorCode" = NULL,
             "safeErrorSummary" = NULL, "retryState" = NULL, "retryAfterAt" = NULL,
             "lastApiResponseAt" = NULL, "lastDbWriteAt" = NULL, "lastProgressAt" = NULL,
             "lastWorkerHeartbeatAt" = NULL, "pausedAt" = NULL, "failedAt" = NULL,
             "cancelledAt" = CURRENT_TIMESTAMP, "completedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP, "resetAt" = CURRENT_TIMESTAMP, "resetBy" = $3
         WHERE "id" = $1 AND "guildId" = $2 RETURNING ${safeJobSelect()}`,
        [job.id, input.guildId, userId],
      );
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, eventType: "IMPORT_STATE_RESET", actorId: userId });
      return result.rows[0];
    }

    const channelResult = await client.query(
      `SELECT * FROM "history_import_channel_progress"
       WHERE "jobId" = $1 AND "guildId" = $2 AND "channelId" = $3 FOR UPDATE`,
      [job.id, input.guildId, input.channelId],
    );
    const channel = channelResult.rows[0];
    if (!channel) throw Object.assign(new Error("Import channel not found"), { status: 404, safeMessage: "Import channel not found" });

    if (input.action === "retry-channel") {
      if (channel.status !== "failed") {
        throw Object.assign(new Error("Channel cannot be retried"), { status: 409, safeMessage: "Only failed channels can be retried" });
      }
      await client.query(
        `UPDATE "history_import_channel_progress"
         SET "status" = 'pending', "retryCount" = 0, "retryAfterAt" = NULL,
             "safeErrorCode" = NULL, "safeErrorSummary" = NULL, "skipRequested" = false,
             "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "jobId" = $2 AND "guildId" = $3`,
        [channel.id, job.id, input.guildId],
      );
      if (["completed", "failed", "stalled"].includes(job.status)) {
        await client.query(
          `UPDATE "history_import_job"
           SET "status" = 'queued', "completedAt" = NULL, "failedAt" = NULL,
               "safeErrorCode" = NULL, "safeErrorSummary" = NULL, "retryState" = NULL,
               "retryAfterAt" = NULL, "currentChannelId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1 AND "guildId" = $2`,
          [job.id, input.guildId],
        );
      }
      await syncChannelCounts(client, job.id);
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, channelId: channel.channelId, eventType: "IMPORT_CHANNEL_RETRY_REQUESTED", actorId: userId });
    } else {
      if (["completed", "skipped", "cancelled"].includes(channel.status)) {
        throw Object.assign(new Error("Channel cannot be skipped"), { status: 409, safeMessage: "This channel is already finished" });
      }
      const requestAtBoundary = channel.status === "running" && activeWorkerStatuses.has(job.status);
      await client.query(
        `UPDATE "history_import_channel_progress"
         SET "status" = CASE WHEN $4 THEN "status" ELSE 'skipped' END,
             "skipRequested" = $4,
             "skipReason" = CASE WHEN $4 THEN "skipReason" ELSE 'USER_SKIPPED' END,
             "safeErrorCode" = CASE WHEN $4 THEN "safeErrorCode" ELSE 'USER_SKIPPED' END,
             "safeErrorSummary" = CASE WHEN $4 THEN "safeErrorSummary" ELSE '管理者がこのチャンネルをスキップしました。' END,
             "completedAt" = CASE WHEN $4 THEN "completedAt" ELSE CURRENT_TIMESTAMP END,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "jobId" = $2 AND "guildId" = $3`,
        [channel.id, job.id, input.guildId, requestAtBoundary],
      );
      if (!requestAtBoundary && job.status === "stalled") {
        await client.query(
          `UPDATE "history_import_job"
           SET "status" = 'queued', "currentChannelId" = NULL, "safeErrorCode" = NULL,
               "safeErrorSummary" = NULL, "retryState" = NULL, "retryAfterAt" = NULL,
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1 AND "guildId" = $2`,
          [job.id, input.guildId],
        );
      }
      await syncChannelCounts(client, job.id);
      await writeAudit(client, { jobId: job.id, guildId: input.guildId, channelId: channel.channelId, eventType: requestAtBoundary ? "IMPORT_CHANNEL_SKIP_REQUESTED" : "IMPORT_CHANNEL_SKIPPED", actorId: userId });
    }
    const result = await client.query(
      `SELECT ${safeJobSelect()} FROM "history_import_job" WHERE "id" = $1 AND "guildId" = $2`,
      [job.id, input.guildId],
    );
    return result.rows[0];
  });
}

export async function POST(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 2_048)) return invalidRequest();
  const body = await request.json().catch(() => null);
  const parsed = parseMessageImportMutation(body);
  if (!parsed.ok) return invalidRequest(parsed.error);
  const input = parsed.value as ImportMutationInput;
  const authorization = await authorizeGuildRequest(request, input.guildId);
  if (authorization.response) return authorization.response;

  const limited = await isRateLimited(request, {
    scope: `history-import-${input.action}-${input.guildId}`,
    limit: input.action === "start" ? 3 : 30,
    windowSeconds: input.action === "start" ? 60 * 60 : 60,
    identity: authorization.userId,
    failClosed: true,
  });
  if (limited) return invalidRequest("Too many import requests. Please wait and try again.", 429);

  try {
    if (!messageImportConfig.enabled) {
      if (input.action !== "start") return invalidRequest("Message History Import v2 is disabled", 503);
      const job = await createLegacyJob(input.guildId, authorization.userId, input.days as number, input.mode ?? "standard");
      return NextResponse.json({ featureEnabled: false, job }, { status: 201 });
    }
    const job = await mutateV2Job(input, authorization.userId);
    return NextResponse.json({ featureEnabled: true, job }, { status: input.action === "start" ? 201 : 200 });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return invalidRequest("This server already has an active message import.", 409);
    }
    const safeError = error as { status?: number; safeMessage?: string };
    if (safeError.status && safeError.safeMessage) return invalidRequest(safeError.safeMessage, safeError.status);
    console.error("Message History Import mutation failed:", error);
    return invalidRequest("Unable to update import state", 500);
  }
}

export async function DELETE(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 1_024)) return invalidRequest();
  if (!messageImportConfig.enabled) return invalidRequest("Message History Import v2 is disabled", 503);
  const body = await request.json().catch(() => null);
  const parsed = parseImportedDataDeletion(body);
  if (!parsed.ok) return invalidRequest(parsed.error);
  const deletion = parsed.value as { guildId: string; confirmation: string };
  const authorization = await authorizeGuildRequest(request, deletion.guildId);
  if (authorization.response) return authorization.response;
  if (await isRateLimited(request, {
    scope: `history-import-delete-${deletion.guildId}`,
    limit: 3,
    windowSeconds: 60 * 60,
    identity: authorization.userId,
    failClosed: true,
  })) return invalidRequest("Too many delete requests. Please wait and try again.", 429);

  try {
    const deletedCount = await withTransaction(async (client) => {
      const active = await client.query(
        `SELECT "id" FROM "history_import_job"
         WHERE "guildId" = $1
           AND "status" IN ('queued', 'preparing', 'running', 'pausing', 'paused', 'cancelling', 'stalled')
         FOR UPDATE`,
        [deletion.guildId],
      );
      if (active.rowCount) {
        throw Object.assign(new Error("Active import cannot be deleted"), {
          status: 409,
          safeMessage: "Cancel the active import before deleting imported history data",
        });
      }
      const result = await client.query(
        `WITH deleted AS (
           DELETE FROM "discord_message"
           WHERE "guildId" = $1 AND "source" = 'history_import'
           RETURNING 1
         ) SELECT count(*)::int AS count FROM deleted`,
        [deletion.guildId],
      );
      const count = result.rows[0]?.count ?? 0;
      await writeAudit(client, {
        guildId: deletion.guildId,
        eventType: "IMPORTED_HISTORY_DATA_DELETED",
        actorId: authorization.userId,
        counts: { deletedMessages: count },
      });
      return count;
    });
    return NextResponse.json({ deletedCount });
  } catch (error) {
    const safeError = error as { status?: number; safeMessage?: string };
    if (safeError.status && safeError.safeMessage) return invalidRequest(safeError.safeMessage, safeError.status);
    console.error("Imported history data deletion failed:", error);
    return invalidRequest("Unable to delete imported history data", 500);
  }
}
