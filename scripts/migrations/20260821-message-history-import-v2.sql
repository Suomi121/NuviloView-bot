-- Message History Import v2 is additive. Existing messages are deliberately
-- classified as "existing" because legacy imports and live events cannot be
-- distinguished safely after the fact.
ALTER TABLE "discord_message"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'existing',
  ADD COLUMN IF NOT EXISTS "importJobId" integer;

CREATE INDEX IF NOT EXISTS "discord_message_guild_source_created_idx"
  ON "discord_message" ("guildId", "source", "createdAt" DESC);

ALTER TABLE "history_import_job"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "totalChannels" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "completedChannels" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "skippedChannels" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "estimatedMessages" integer,
  ADD COLUMN IF NOT EXISTS "fetchedMessages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "insertedMessages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "duplicateMessages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failedMessages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "currentChannelId" text,
  ADD COLUMN IF NOT EXISTS "cancelRequested" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pauseRequested" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "safeErrorCode" text,
  ADD COLUMN IF NOT EXISTS "safeErrorSummary" text,
  ADD COLUMN IF NOT EXISTS "retryState" text,
  ADD COLUMN IF NOT EXISTS "retryAfterAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "lastApiResponseAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "lastDbWriteAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "lastProgressAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "lastWorkerHeartbeatAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "workerHostId" text,
  ADD COLUMN IF NOT EXISTS "workerInstanceId" text,
  ADD COLUMN IF NOT EXISTS "pausedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "cancelledAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "failedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "resetAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "resetBy" text;

CREATE INDEX IF NOT EXISTS "history_import_job_guild_requested_idx"
  ON "history_import_job" ("guildId", "requestedAt" DESC);

CREATE INDEX IF NOT EXISTS "history_import_job_status_progress_idx"
  ON "history_import_job" ("status", "lastProgressAt");

CREATE UNIQUE INDEX IF NOT EXISTS "history_import_job_one_active_per_guild_v2_idx"
  ON "history_import_job" ("guildId")
  WHERE "status" IN ('queued', 'preparing', 'running', 'pausing', 'paused', 'cancelling', 'stalled');

CREATE TABLE IF NOT EXISTS "history_import_channel_progress" (
  "id" serial PRIMARY KEY,
  "jobId" integer NOT NULL REFERENCES "history_import_job"("id") ON DELETE CASCADE,
  "guildId" text NOT NULL,
  "channelId" text NOT NULL,
  "channelName" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "skipReason" text,
  "nextBeforeMessageId" text,
  "oldestMessageId" text,
  "fetchedCount" integer NOT NULL DEFAULT 0,
  "insertedCount" integer NOT NULL DEFAULT 0,
  "duplicateCount" integer NOT NULL DEFAULT 0,
  "failedCount" integer NOT NULL DEFAULT 0,
  "skipRequested" boolean NOT NULL DEFAULT false,
  "retryCount" integer NOT NULL DEFAULT 0,
  "retryAfterAt" timestamptz,
  "lastApiResponseAt" timestamptz,
  "lastDbWriteAt" timestamptz,
  "lastProgressAt" timestamptz,
  "startedAt" timestamptz,
  "completedAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "safeErrorCode" text,
  "safeErrorSummary" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "history_import_channel_job_channel_unique"
  ON "history_import_channel_progress" ("jobId", "channelId");

CREATE INDEX IF NOT EXISTS "history_import_channel_job_status_idx"
  ON "history_import_channel_progress" ("jobId", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "history_import_channel_guild_channel_idx"
  ON "history_import_channel_progress" ("guildId", "channelId");

CREATE TABLE IF NOT EXISTS "message_import_audit_event" (
  "id" serial PRIMARY KEY,
  "jobId" integer,
  "guildId" text NOT NULL,
  "channelId" text,
  "eventType" text NOT NULL,
  "actorId" text,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "safeErrorCode" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "message_import_audit_guild_created_idx"
  ON "message_import_audit_event" ("guildId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "message_import_audit_job_created_idx"
  ON "message_import_audit_event" ("jobId", "createdAt" DESC);
