-- NuviloView Web Auth Recovery v1
-- Apply manually to an isolated Supabase PostgreSQL database before canary.
-- This script contains only Better Auth, Guild authorization cache and user
-- settings and route-security tables. It intentionally contains no Analytics
-- or Bot event data and is never replicated to Turso.

BEGIN;

CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false,
  "image" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamp NOT NULL,
  "token" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" ("userId");

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" text,
  "password" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "account_provider_account_idx" ON "account" ("providerId", "accountId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now(),
  "updatedAt" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "discord_managed_guild_cache" (
  "userId" text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "guilds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_preference" (
  "userId" text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "timeZone" text NOT NULL DEFAULT 'Asia/Tokyo',
  "language" text NOT NULL DEFAULT 'ja',
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_preference_language_check" CHECK ("language" IN ('ja', 'en'))
);

CREATE TABLE IF NOT EXISTS "guild_theme" (
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "guildId" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'dark',
  "primaryColor" text NOT NULL DEFAULT '#6677ff',
  "accentColor" text NOT NULL DEFAULT '#9b8cff',
  "backgroundColor" text NOT NULL DEFAULT '#111116',
  "cardColor" text NOT NULL DEFAULT '#1c1c24',
  "radius" text NOT NULL DEFAULT 'default',
  "brandName" text NOT NULL DEFAULT 'NuviloView:OEM',
  "logoUrl" text,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "guild_theme_user_guild_unique" ON "guild_theme" ("userId", "guildId");

-- Auth/Guild/settings routes keep their existing abuse protection without
-- consulting Neon. Only Web Auth scope keys are written by this adapter.
CREATE TABLE IF NOT EXISTS "api_rate_limit" (
  "key" text NOT NULL,
  "bucketStart" timestamptz NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("key", "bucketStart")
);
CREATE INDEX IF NOT EXISTS "api_rate_limit_bucket_start_idx" ON "api_rate_limit" ("bucketStart");

-- Supabase exposes the public schema through its Data API. Web Auth uses only
-- the server-side PostgreSQL URL, so browser-facing roles receive no grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "user", "session", "account", "verification",
      "discord_managed_guild_cache", "user_preference", "guild_theme", "api_rate_limit" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "user", "session", "account", "verification",
      "discord_managed_guild_cache", "user_preference", "guild_theme", "api_rate_limit" FROM authenticated;
  END IF;
END
$$;

COMMIT;
