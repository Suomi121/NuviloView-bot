import pg from "pg";

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
  console.log("Database migration completed.");
} finally {
  await pool.end();
}
