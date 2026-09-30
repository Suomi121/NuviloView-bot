CREATE TABLE "guild_spam_policy" (
  "guild_id" text PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT true,
  "preset" text NOT NULL DEFAULT 'NORMAL',
  "message_count_threshold" integer NOT NULL DEFAULT 3,
  "message_window_seconds" integer NOT NULL DEFAULT 5,
  "duplicate_count_threshold" integer NOT NULL DEFAULT 3,
  "duplicate_window_seconds" integer NOT NULL DEFAULT 20,
  "mention_count_threshold" integer NOT NULL DEFAULT 5,
  "mention_window_seconds" integer NOT NULL DEFAULT 10,
  "link_count_threshold" integer NOT NULL DEFAULT 4,
  "link_window_seconds" integer NOT NULL DEFAULT 20,
  "cross_channel_threshold" integer NOT NULL DEFAULT 3,
  "cross_channel_window_seconds" integer NOT NULL DEFAULT 15,
  "action" text NOT NULL DEFAULT 'ALERT',
  "ignore_bots" boolean NOT NULL DEFAULT false,
  "ignore_admins" boolean NOT NULL DEFAULT false,
  "ignored_role_ids" text[] NOT NULL DEFAULT '{}',
  "ignored_channel_ids" text[] NOT NULL DEFAULT '{}',
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "guild_spam_policy_preset_check"
    CHECK ("preset" IN ('RELAXED', 'NORMAL', 'STRICT', 'CUSTOM')),
  CONSTRAINT "guild_spam_policy_action_check"
    CHECK ("action" IN ('LOG_ONLY', 'ALERT', 'INCIDENT')),
  CONSTRAINT "guild_spam_policy_thresholds_check"
    CHECK (
      "message_count_threshold" BETWEEN 1 AND 100
      AND "duplicate_count_threshold" BETWEEN 1 AND 100
      AND "mention_count_threshold" BETWEEN 1 AND 100
      AND "link_count_threshold" BETWEEN 1 AND 100
      AND "cross_channel_threshold" BETWEEN 1 AND 100
    ),
  CONSTRAINT "guild_spam_policy_windows_check"
    CHECK (
      "message_window_seconds" BETWEEN 1 AND 300
      AND "duplicate_window_seconds" BETWEEN 1 AND 300
      AND "mention_window_seconds" BETWEEN 1 AND 300
      AND "link_window_seconds" BETWEEN 1 AND 300
      AND "cross_channel_window_seconds" BETWEEN 1 AND 300
    ),
  CONSTRAINT "guild_spam_policy_preset_values_check"
    CHECK (
      "preset" = 'CUSTOM'
      OR ("preset" = 'RELAXED'
        AND "message_count_threshold" = 10 AND "message_window_seconds" = 10
        AND "duplicate_count_threshold" = 5 AND "duplicate_window_seconds" = 20
        AND "mention_count_threshold" = 10 AND "mention_window_seconds" = 10
        AND "link_count_threshold" = 8 AND "link_window_seconds" = 20
        AND "cross_channel_threshold" = 5 AND "cross_channel_window_seconds" = 15)
      OR ("preset" = 'NORMAL'
        AND "message_count_threshold" = 3 AND "message_window_seconds" = 5
        AND "duplicate_count_threshold" = 3 AND "duplicate_window_seconds" = 20
        AND "mention_count_threshold" = 5 AND "mention_window_seconds" = 10
        AND "link_count_threshold" = 4 AND "link_window_seconds" = 20
        AND "cross_channel_threshold" = 3 AND "cross_channel_window_seconds" = 15)
      OR ("preset" = 'STRICT'
        AND "message_count_threshold" = 3 AND "message_window_seconds" = 3
        AND "duplicate_count_threshold" = 3 AND "duplicate_window_seconds" = 30
        AND "mention_count_threshold" = 4 AND "mention_window_seconds" = 10
        AND "link_count_threshold" = 3 AND "link_window_seconds" = 20
        AND "cross_channel_threshold" = 2 AND "cross_channel_window_seconds" = 15)
    ),
  CONSTRAINT "guild_spam_policy_ignored_ids_check"
    CHECK (cardinality("ignored_role_ids") <= 50 AND cardinality("ignored_channel_ids") <= 50)
);

CREATE TABLE "guild_spam_policy_audit" (
  "id" bigserial PRIMARY KEY,
  "guild_id" text NOT NULL,
  "changed_by" text NOT NULL,
  "old_preset" text,
  "new_preset" text NOT NULL,
  "changed_fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "guild_spam_policy_audit_presets_check"
    CHECK (
      ("old_preset" IS NULL OR "old_preset" IN ('RELAXED', 'NORMAL', 'STRICT', 'CUSTOM'))
      AND "new_preset" IN ('RELAXED', 'NORMAL', 'STRICT', 'CUSTOM', 'DEFAULT')
    ),
  CONSTRAINT "guild_spam_policy_audit_fields_array_check"
    CHECK (jsonb_typeof("changed_fields") = 'array')
);

CREATE INDEX "guild_spam_policy_audit_guild_created_idx"
  ON "guild_spam_policy_audit" ("guild_id", "created_at" DESC);
