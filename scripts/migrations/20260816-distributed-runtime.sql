-- Distributed runtime coordination for the Discord Bot. This migration is
-- additive: the legacy bot_heartbeat table remains for compatibility.
CREATE TABLE IF NOT EXISTS "service_lease" (
  "serviceKey" text PRIMARY KEY,
  "ownerInstanceId" text,
  "hostId" text,
  "fencingToken" bigint NOT NULL DEFAULT 0,
  "leaseExpiresAt" timestamptz NOT NULL DEFAULT to_timestamp(0),
  "acquiredAt" timestamptz,
  "renewedAt" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "service_lease_owner_pair_check" CHECK (
    ("ownerInstanceId" IS NULL AND "hostId" IS NULL)
    OR ("ownerInstanceId" IS NOT NULL AND "hostId" IS NOT NULL)
  ),
  CONSTRAINT "service_lease_fencing_token_check" CHECK ("fencingToken" >= 0)
);

CREATE INDEX IF NOT EXISTS "service_lease_expiry_idx"
  ON "service_lease" ("leaseExpiresAt");

CREATE TABLE IF NOT EXISTS "service_heartbeat" (
  "instanceId" text PRIMARY KEY,
  "serviceKey" text NOT NULL REFERENCES "service_lease"("serviceKey") ON DELETE RESTRICT,
  "hostId" text NOT NULL,
  "fencingToken" bigint,
  "platform" text NOT NULL,
  "hostname" text NOT NULL,
  "pid" integer NOT NULL,
  "startedAt" timestamptz NOT NULL,
  "lastHeartbeatAt" timestamptz NOT NULL DEFAULT now(),
  "status" text NOT NULL,
  "leaseState" text NOT NULL,
  "appVersion" text NOT NULL,
  "runtimeVersion" text NOT NULL,
  "commitSha" text,
  "guildCount" integer NOT NULL DEFAULT 0,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "stoppedAt" timestamptz,
  CONSTRAINT "service_heartbeat_status_check" CHECK (
    "status" IN ('Starting', 'Running', 'LeaseContended', 'LeaseLost', 'Stopping', 'Stopped', 'Error')
  ),
  CONSTRAINT "service_heartbeat_lease_state_check" CHECK (
    "leaseState" IN ('Acquiring', 'Owned', 'Contended', 'Renewing', 'Lost', 'Released', 'Unknown')
  ),
  CONSTRAINT "service_heartbeat_pid_check" CHECK ("pid" > 0),
  CONSTRAINT "service_heartbeat_guild_count_check" CHECK ("guildCount" >= 0)
);

CREATE INDEX IF NOT EXISTS "service_heartbeat_service_last_idx"
  ON "service_heartbeat" ("serviceKey", "lastHeartbeatAt" DESC);

CREATE INDEX IF NOT EXISTS "service_heartbeat_host_last_idx"
  ON "service_heartbeat" ("hostId", "lastHeartbeatAt" DESC);

CREATE INDEX IF NOT EXISTS "service_heartbeat_service_started_idx"
  ON "service_heartbeat" ("serviceKey", "startedAt" DESC);

COMMENT ON TABLE "service_lease" IS
  'Cross-host lease for singleton services. Ownership changes increment fencingToken atomically.';

COMMENT ON TABLE "service_heartbeat" IS
  'Per-process runtime heartbeat history. No secrets or full command lines are stored.';
