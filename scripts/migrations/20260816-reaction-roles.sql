CREATE TABLE IF NOT EXISTS "reaction_role_rule" (
  "id" serial PRIMARY KEY,
  "guildId" text NOT NULL,
  "channelId" text NOT NULL,
  "messageId" text NOT NULL,
  "emojiKey" text NOT NULL,
  "emojiDisplay" text NOT NULL,
  "roleIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reaction_role_rule_target_unique" UNIQUE ("guildId", "messageId", "emojiKey"),
  CONSTRAINT "reaction_role_rule_roles_array_check" CHECK (jsonb_typeof("roleIds") = 'array')
);

CREATE INDEX IF NOT EXISTS "reaction_role_rule_guild_channel_idx"
  ON "reaction_role_rule" ("guildId", "channelId");
