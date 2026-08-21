import pg from "pg";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set before running migrations.");
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "daily_stats" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "memberCount" integer NOT NULL DEFAULT 0,
      "messageCount" integer NOT NULL DEFAULT 0,
      "date" date NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "daily_stats_guild_date_unique" UNIQUE ("guildId", "date")
    )
  `);
  await pool.query(`
    ALTER TABLE "daily_stats"
    ADD COLUMN IF NOT EXISTS "reactionCount" integer NOT NULL DEFAULT 0
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "daily_active_member" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "userId" text NOT NULL,
      "date" date NOT NULL,
      CONSTRAINT "daily_active_member_guild_user_date_unique" UNIQUE ("guildId", "userId", "date")
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "recent_activity" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "type" text NOT NULL,
      "actorName" text NOT NULL,
      "channelName" text,
      "occurredAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "recent_activity_guild_occurred_at_idx"
    ON "recent_activity" ("guildId", "occurredAt" DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user_preference" (
      "userId" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
      "timeZone" text NOT NULL DEFAULT 'Asia/Tokyo',
      "language" text NOT NULL DEFAULT 'ja',
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "discord_managed_guild_cache" (
      "userId" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
      "guilds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_theme" (
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "guildId" text NOT NULL,
      "mode" text NOT NULL DEFAULT 'dark',
      "primaryColor" text NOT NULL DEFAULT '#6677ff',
      "accentColor" text NOT NULL DEFAULT '#9b8cff',
      "backgroundColor" text NOT NULL DEFAULT '#111116',
      "cardColor" text NOT NULL DEFAULT '#1c1c24',
      "radius" text NOT NULL DEFAULT 'default',
      "brandName" text NOT NULL DEFAULT 'NuviloView:OEM',
      "logoUrl" text,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("userId", "guildId")
    )
  `);
  // A theme is personal to the authenticated dashboard user. Keeping the
  // server in the key lets one person use different themes per server without
  // letting another administrator change their appearance.
  await pool.query('DROP INDEX IF EXISTS "guild_theme_guild_unique"');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS "guild_theme_user_guild_unique" ON "guild_theme" ("userId", "guildId")');
  await pool.query(
    `ALTER TABLE "user_preference" ADD COLUMN IF NOT EXISTS "language" text NOT NULL DEFAULT 'ja'`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "support_request" (
      "id" serial PRIMARY KEY,
      "userId" text,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "message" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "discord_message" (
      "id" text PRIMARY KEY,
      "guildId" text NOT NULL,
      "channelName" text NOT NULL,
      "authorId" text NOT NULL,
      "authorName" text NOT NULL,
      "content" text NOT NULL,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "discord_message_guild_created_at_idx"
    ON "discord_message" ("guildId", "createdAt" DESC)
  `);
  await pool.query('ALTER TABLE "discord_message" ADD COLUMN IF NOT EXISTS "channelId" text');
  await pool.query('ALTER TABLE "discord_message" ADD COLUMN IF NOT EXISTS "authorIsBot" boolean NOT NULL DEFAULT false');
  await pool.query(`ALTER TABLE "discord_message" ADD COLUMN IF NOT EXISTS "authorRoleIds" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query('CREATE INDEX IF NOT EXISTS "discord_message_guild_channel_created_idx" ON "discord_message" ("guildId", "channelId", "createdAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "discord_message_guild_author_created_idx" ON "discord_message" ("guildId", "authorId", "createdAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "discord_message_author_roles_gin_idx" ON "discord_message" USING gin ("authorRoleIds")');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "voice_session" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "userId" text NOT NULL,
      "channelId" text NOT NULL,
      "startedAt" timestamptz NOT NULL DEFAULT now(),
      "endedAt" timestamptz
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "voice_session_guild_started_at_idx"
    ON "voice_session" ("guildId", "startedAt" DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "voice_session_one_active_session_per_member_idx"
    ON "voice_session" ("guildId", "userId")
    WHERE "endedAt" IS NULL
  `);
  await pool.query('ALTER TABLE "voice_session" ADD COLUMN IF NOT EXISTS "userIsBot" boolean NOT NULL DEFAULT false');
  await pool.query(`ALTER TABLE "voice_session" ADD COLUMN IF NOT EXISTS "userRoleIds" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query('CREATE INDEX IF NOT EXISTS "voice_session_guild_channel_started_idx" ON "voice_session" ("guildId", "channelId", "startedAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "voice_session_user_roles_gin_idx" ON "voice_session" USING gin ("userRoleIds")');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_member_event" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "userId" text NOT NULL,
      "eventType" text NOT NULL CHECK ("eventType" IN ('join', 'leave')),
      "isBot" boolean NOT NULL DEFAULT false,
      "roleIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "source" text NOT NULL DEFAULT 'gateway',
      "occurredAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_member_event_guild_occurred_idx" ON "guild_member_event" ("guildId", "occurredAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_member_event_guild_user_occurred_idx" ON "guild_member_event" ("guildId", "userId", "occurredAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_member_event_roles_gin_idx" ON "guild_member_event" USING gin ("roleIds")');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "discord_reaction_event" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "channelId" text,
      "messageId" text NOT NULL,
      "reactorId" text NOT NULL,
      "recipientId" text,
      "reactorIsBot" boolean NOT NULL DEFAULT false,
      "reactorRoleIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "occurredAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "discord_reaction_event_guild_occurred_idx" ON "discord_reaction_event" ("guildId", "occurredAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "discord_reaction_event_guild_channel_occurred_idx" ON "discord_reaction_event" ("guildId", "channelId", "occurredAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "discord_reaction_event_roles_gin_idx" ON "discord_reaction_event" USING gin ("reactorRoleIds")');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_channel_registry" (
      "guildId" text NOT NULL,
      "channelId" text NOT NULL,
      "channelName" text NOT NULL,
      "channelType" text NOT NULL,
      "deletedAt" timestamptz,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("guildId", "channelId")
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_channel_registry_guild_updated_idx" ON "guild_channel_registry" ("guildId", "updatedAt" DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_role_registry" (
      "guildId" text NOT NULL,
      "roleId" text NOT NULL,
      "roleName" text NOT NULL,
      "memberCount" integer NOT NULL DEFAULT 0,
      "isManaged" boolean NOT NULL DEFAULT false,
      "isBotRole" boolean NOT NULL DEFAULT false,
      "isEveryone" boolean NOT NULL DEFAULT false,
      "color" integer NOT NULL DEFAULT 0,
      "position" integer NOT NULL DEFAULT 0,
      "deletedAt" timestamptz,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("guildId", "roleId")
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_role_registry_guild_position_idx" ON "guild_role_registry" ("guildId", "position" DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "analytics_health_snapshot" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "date" date NOT NULL,
      "periodDays" integer NOT NULL,
      "score" integer,
      "confidence" text NOT NULL,
      "categories" jsonb NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "analytics_health_snapshot_guild_date_period_unique" UNIQUE ("guildId", "date", "periodDays")
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "voice_server_session" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "startedAt" timestamptz NOT NULL DEFAULT now(),
      "endedAt" timestamptz
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "voice_server_session_guild_started_at_idx"
    ON "voice_server_session" ("guildId", "startedAt" DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "bot_channel_access" (
      "guildId" text NOT NULL,
      "channelId" text NOT NULL,
      "channelName" text NOT NULL,
      "canRead" boolean NOT NULL DEFAULT false,
      "checkedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("guildId", "channelId")
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "bot_channel_access_guild_checked_at_idx"
    ON "bot_channel_access" ("guildId", "checkedAt" DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "bot_guild_blocklist" (
      "guildId" text PRIMARY KEY,
      "reason" text NOT NULL,
      "blockedBy" text NOT NULL,
      "blockedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "bot_guild_block_audit" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "action" text NOT NULL,
      "reason" text,
      "performedBy" text NOT NULL,
      "performedByName" text,
      "source" text NOT NULL DEFAULT 'bot_command',
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "bot_guild_block_audit_guild_created_at_idx"
    ON "bot_guild_block_audit" ("guildId", "createdAt" DESC)
  `);
  await pool.query('ALTER TABLE "bot_guild_block_audit" ADD COLUMN IF NOT EXISTS "previousHash" text');
  await pool.query('ALTER TABLE "bot_guild_block_audit" ADD COLUMN IF NOT EXISTS "entryHash" text');
  await pool.query('CREATE INDEX IF NOT EXISTS "bot_guild_block_audit_hash_idx" ON "bot_guild_block_audit" ("entryHash") WHERE "entryHash" IS NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "bot_moderation_audit" (
      "id" text PRIMARY KEY,
      "guildId" text NOT NULL,
      "guildName" text,
      "action" text NOT NULL,
      "actorId" text NOT NULL,
      "actorName" text,
      "targetId" text,
      "targetName" text,
      "channelId" text,
      "reason" text NOT NULL,
      "requestedCount" integer,
      "affectedCount" integer,
      "status" text NOT NULL DEFAULT 'pending',
      "errorCode" text,
      "errorMessage" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "completedAt" timestamptz,
      CONSTRAINT "bot_moderation_audit_status_check"
        CHECK ("status" IN ('pending', 'success', 'failed'))
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "bot_moderation_audit_guild_created_idx"
    ON "bot_moderation_audit" ("guildId", "createdAt" DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "bot_moderation_audit_actor_created_idx"
    ON "bot_moderation_audit" ("actorId", "createdAt" DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "bot_guild_registry" (
      "guildId" text PRIMARY KEY,
      "name" text NOT NULL,
      "iconUrl" text,
      "ownerId" text,
      "memberCount" integer NOT NULL DEFAULT 0,
      "isConnected" boolean NOT NULL DEFAULT true,
      "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "bot_guild_registry_connected_seen_idx"
    ON "bot_guild_registry" ("isConnected", "lastSeenAt" DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "translation_usage" (
      "month" date PRIMARY KEY,
      "characterCount" integer NOT NULL DEFAULT 0,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "bot_heartbeat" (
      "id" text PRIMARY KEY,
      "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
      "startedAt" timestamptz NOT NULL DEFAULT now(),
      "guildCount" integer NOT NULL DEFAULT 0,
      "stoppedAt" timestamptz
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "voice_server_session_one_active_session_idx"
    ON "voice_server_session" ("guildId")
    WHERE "endedAt" IS NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user_notification" (
      "id" serial PRIMARY KEY,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "guildId" text NOT NULL,
      "type" text NOT NULL,
      "title" text NOT NULL,
      "body" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz,
      CONSTRAINT "user_notification_user_guild_type_unique" UNIQUE ("userId", "guildId", "type")
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_alert_event" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "type" text NOT NULL,
      "severity" text NOT NULL DEFAULT 'warning',
      "title" text NOT NULL,
      "body" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "guild_alert_event_guild_created_at_idx"
    ON "guild_alert_event" ("guildId", "createdAt" DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_goal" (
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "guildId" text NOT NULL,
      "type" text NOT NULL,
      "target" integer NOT NULL CHECK ("target" > 0),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "guild_goal_user_guild_type_unique" UNIQUE ("userId", "guildId", "type")
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_public_report" (
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "guildId" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "enabled" boolean NOT NULL DEFAULT false,
      "description" text NOT NULL DEFAULT '',
      "showMembers" boolean NOT NULL DEFAULT true,
      "showMessages" boolean NOT NULL DEFAULT true,
      "showVoice" boolean NOT NULL DEFAULT true,
      "showChannels" boolean NOT NULL DEFAULT true,
      "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "publishedAt" timestamptz,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "guild_public_report_user_guild_unique" UNIQUE ("userId", "guildId")
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "api_rate_limit" (
      "key" text NOT NULL,
      "bucketStart" timestamptz NOT NULL,
      "count" integer NOT NULL DEFAULT 0,
      PRIMARY KEY ("key", "bucketStart")
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "api_rate_limit_bucket_start_idx"
    ON "api_rate_limit" ("bucketStart")
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "history_import_job" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "requestedBy" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "days" integer NOT NULL,
      "mode" text NOT NULL DEFAULT 'standard',
      "status" text NOT NULL DEFAULT 'queued',
      "processedMessages" integer NOT NULL DEFAULT 0,
      "failedChannels" integer NOT NULL DEFAULT 0,
      "requestedAt" timestamptz NOT NULL DEFAULT now(),
      "startedAt" timestamptz,
      "completedAt" timestamptz,
      "error" text
    )
  `);
  await pool.query(
    `ALTER TABLE "history_import_job" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'standard'`,
  );
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "history_import_job_one_active_per_guild_idx"
    ON "history_import_job" ("guildId")
    WHERE "status" IN ('queued', 'running')
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_settings" (
      "guildId" text PRIMARY KEY,
      "enabled" boolean NOT NULL DEFAULT false,
      "protectedChannelIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "protectedRoleIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "resetLogChannelId" text,
      "backupChannelId" text,
      "allowedAdminIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "maxChannelDeletes" integer,
      "maxRoleDeletes" integer,
      "maxTotalOperations" integer,
      "guildCooldownHours" integer,
      "developerCooldownMinutes" integer,
      "defaultMode" text NOT NULL DEFAULT 'channels_only',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "guild_reset_settings_default_mode_check"
        CHECK ("defaultMode" IN ('channels_only', 'channels_and_roles', 'settings_reset')),
      CONSTRAINT "guild_reset_settings_nonnegative_limits_check"
        CHECK (
          ("maxChannelDeletes" IS NULL OR "maxChannelDeletes" >= 0)
          AND ("maxRoleDeletes" IS NULL OR "maxRoleDeletes" >= 0)
          AND ("maxTotalOperations" IS NULL OR "maxTotalOperations" >= 1)
          AND ("guildCooldownHours" IS NULL OR "guildCooldownHours" >= 0)
          AND ("developerCooldownMinutes" IS NULL OR "developerCooldownMinutes" >= 0)
        )
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_plan" (
      "id" text PRIMARY KEY,
      "guildId" text NOT NULL,
      "developerId" text NOT NULL,
      "developerName" text,
      "mode" text NOT NULL,
      "dryRun" boolean NOT NULL DEFAULT true,
      "requestedOptions" jsonb NOT NULL,
      "targetSnapshotHash" text NOT NULL,
      "targetSummary" jsonb NOT NULL,
      "status" text NOT NULL DEFAULT 'active',
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "usedAt" timestamptz,
      CONSTRAINT "guild_reset_plan_mode_check"
        CHECK ("mode" IN ('channels_only', 'channels_and_roles', 'settings_reset'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_plan_guild_created_idx" ON "guild_reset_plan" ("guildId", "createdAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_plan_developer_created_idx" ON "guild_reset_plan" ("developerId", "createdAt" DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_confirmation" (
      "id" text PRIMARY KEY,
      "planId" text NOT NULL REFERENCES "guild_reset_plan"("id") ON DELETE CASCADE,
      "guildId" text NOT NULL,
      "developerId" text NOT NULL,
      "codeHash" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "usedAt" timestamptz,
      "usedByRequestId" text,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_confirmation_plan_created_idx" ON "guild_reset_confirmation" ("planId", "createdAt" DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_execution" (
      "id" text PRIMARY KEY,
      "planId" text NOT NULL REFERENCES "guild_reset_plan"("id"),
      "guildId" text NOT NULL,
      "developerId" text NOT NULL,
      "developerName" text,
      "mode" text NOT NULL,
      "dryRun" boolean NOT NULL DEFAULT true,
      "reason" text NOT NULL,
      "source" text NOT NULL DEFAULT 'bot_command',
      "status" text NOT NULL DEFAULT 'running',
      "backupPath" text,
      "requestedCount" integer NOT NULL DEFAULT 0,
      "successCount" integer NOT NULL DEFAULT 0,
      "failedCount" integer NOT NULL DEFAULT 0,
      "skippedCount" integer NOT NULL DEFAULT 0,
      "operationStarted" boolean NOT NULL DEFAULT false,
      "beforeSummary" jsonb,
      "afterSummary" jsonb,
      "errorSummary" text,
      "startedAt" timestamptz NOT NULL DEFAULT now(),
      "finishedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_execution_guild_created_idx" ON "guild_reset_execution" ("guildId", "createdAt" DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_execution_developer_created_idx" ON "guild_reset_execution" ("developerId", "createdAt" DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_execution_item" (
      "id" serial PRIMARY KEY,
      "executionId" text NOT NULL REFERENCES "guild_reset_execution"("id") ON DELETE CASCADE,
      "targetType" text NOT NULL,
      "targetId" text,
      "targetName" text,
      "action" text NOT NULL,
      "status" text NOT NULL,
      "errorCode" text,
      "errorMessage" text,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_execution_item_execution_idx" ON "guild_reset_execution_item" ("executionId", "id")');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_backup" (
      "id" text PRIMARY KEY,
      "executionId" text NOT NULL REFERENCES "guild_reset_execution"("id") ON DELETE CASCADE,
      "planId" text NOT NULL REFERENCES "guild_reset_plan"("id"),
      "guildId" text NOT NULL,
      "fileName" text NOT NULL,
      "filePath" text NOT NULL,
      "fileSize" integer NOT NULL,
      "checksum" text NOT NULL,
      "schemaVersion" integer NOT NULL DEFAULT 1,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_backup_guild_created_idx" ON "guild_reset_backup" ("guildId", "createdAt" DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_lock" (
      "scope" text PRIMARY KEY,
      "guildId" text NOT NULL,
      "executionId" text NOT NULL,
      "lockedAt" timestamptz NOT NULL DEFAULT now(),
      "expiresAt" timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "guild_reset_request" (
      "id" text PRIMARY KEY,
      "action" text NOT NULL,
      "guildId" text NOT NULL,
      "developerId" text NOT NULL,
      "developerName" text,
      "payload" jsonb NOT NULL,
      "confirmationId" text,
      "status" text NOT NULL DEFAULT 'queued',
      "result" jsonb,
      "errorCode" text,
      "errorMessage" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "claimedAt" timestamptz,
      "completedAt" timestamptz,
      CONSTRAINT "guild_reset_request_action_check"
        CHECK ("action" IN ('plan', 'confirm')),
      CONSTRAINT "guild_reset_request_status_check"
        CHECK ("status" IN ('queued', 'running', 'completed', 'failed'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_request_status_created_idx" ON "guild_reset_request" ("status", "createdAt")');
  await pool.query('CREATE INDEX IF NOT EXISTS "guild_reset_request_guild_created_idx" ON "guild_reset_request" ("guildId", "createdAt" DESC)');
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recent_activity' AND column_name = 'occurredAt'
          AND data_type = 'timestamp without time zone'
      ) THEN
        ALTER TABLE "recent_activity"
          ALTER COLUMN "occurredAt" TYPE timestamptz
          USING "occurredAt" AT TIME ZONE 'UTC';
      END IF;
    END $$
  `);
  const nukeProtectionMigration = await readFile(
    new URL("./migrations/20260814-nuke-protection-v1.sql", import.meta.url),
    "utf8",
  );
  await pool.query(nukeProtectionMigration);
  const securityV1Migration = await readFile(
    new URL("./migrations/20260821-security-v1.sql", import.meta.url),
    "utf8",
  );
  await pool.query(securityV1Migration);
  const distributedRuntimeMigration = await readFile(
    new URL("./migrations/20260816-distributed-runtime.sql", import.meta.url),
    "utf8",
  );
  await pool.query(distributedRuntimeMigration);
  const reactionRoleMigration = await readFile(
    new URL("./migrations/20260816-reaction-roles.sql", import.meta.url),
    "utf8",
  );
  await pool.query(reactionRoleMigration);
  console.log("Database migration completed.");
} finally {
  await pool.end();
}
