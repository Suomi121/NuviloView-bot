-- These indexes support small, ordered retention batches. Apply during a
-- reviewed maintenance window because index creation can briefly increase DB
-- load even though it does not delete or rewrite application data.
CREATE INDEX IF NOT EXISTS "discord_message_retention_idx"
  ON "discord_message" ("createdAt", "id");

CREATE INDEX IF NOT EXISTS "daily_active_member_retention_idx"
  ON "daily_active_member" ("date", "id");

CREATE INDEX IF NOT EXISTS "recent_activity_retention_idx"
  ON "recent_activity" ("occurredAt", "id");

CREATE INDEX IF NOT EXISTS "voice_session_retention_idx"
  ON "voice_session" ("endedAt", "id")
  WHERE "endedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "voice_server_session_retention_idx"
  ON "voice_server_session" ("endedAt", "id")
  WHERE "endedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "guild_member_event_retention_idx"
  ON "guild_member_event" ("occurredAt", "id");

CREATE INDEX IF NOT EXISTS "discord_reaction_event_retention_idx"
  ON "discord_reaction_event" ("occurredAt", "id");

CREATE INDEX IF NOT EXISTS "service_heartbeat_retention_idx"
  ON "service_heartbeat" ("lastHeartbeatAt", "instanceId");

CREATE INDEX IF NOT EXISTS "bot_moderation_audit_retention_idx"
  ON "bot_moderation_audit" ("createdAt", "id");
