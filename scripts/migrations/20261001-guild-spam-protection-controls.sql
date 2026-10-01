ALTER TABLE "guild_spam_policy"
  ADD COLUMN "strength" smallint,
  ADD COLUMN "policy_mode" text,
  ADD COLUMN "message_burst_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "duplicate_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "mention_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "link_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "cross_channel_enabled" boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT "guild_spam_policy_strength_check"
    CHECK ("strength" IS NULL OR "strength" BETWEEN 0 AND 100),
  ADD CONSTRAINT "guild_spam_policy_mode_check"
    CHECK ("policy_mode" IS NULL OR "policy_mode" IN ('STRENGTH', 'CUSTOM'));

ALTER TABLE "guild_spam_policy_audit"
  ADD COLUMN "changes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "guild_spam_policy_audit_changes_object_check"
    CHECK (jsonb_typeof("changes") = 'object');
