CREATE TABLE IF NOT EXISTS "security_policy" (
  "guildId" text PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT true,
  "mode" text NOT NULL DEFAULT 'shadow' CHECK ("mode" IN ('shadow', 'manual')),
  "sensitivity" text NOT NULL DEFAULT 'balanced' CHECK ("sensitivity" IN ('low', 'balanced', 'high', 'custom')),
  "alertEnabled" boolean NOT NULL DEFAULT true,
  "alertChannelId" text,
  "manualContainment" boolean NOT NULL DEFAULT true,
  "automaticContainment" boolean NOT NULL DEFAULT false CHECK ("automaticContainment" = false),
  "snapshotEnabled" boolean NOT NULL DEFAULT true,
  "riskWeights" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "thresholds" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "snapshotRetentionCount" integer NOT NULL DEFAULT 7 CHECK ("snapshotRetentionCount" BETWEEN 1 AND 30),
  "snapshotRetentionDays" integer NOT NULL DEFAULT 30 CHECK ("snapshotRetentionDays" BETWEEN 1 AND 365),
  "incidentRetentionDays" integer NOT NULL DEFAULT 90 CHECK ("incidentRetentionDays" BETWEEN 7 AND 730),
  "protectionStatus" text NOT NULL DEFAULT 'Disabled' CHECK ("protectionStatus" IN ('Active', 'Limited', 'Disabled', 'Error')),
  "statusReason" text,
  "lastDiagnosticAt" timestamptz,
  "lastIncidentAt" timestamptz,
  "updatedBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "security_trusted_actor" (
  "guildId" text NOT NULL,
  "actorId" text NOT NULL,
  "label" text,
  "actorType" text NOT NULL DEFAULT 'unknown',
  "trustedBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("guildId", "actorId")
);

CREATE TABLE IF NOT EXISTS "security_incident" (
  "id" text PRIMARY KEY,
  "guildId" text NOT NULL,
  "actorId" text,
  "actorType" text NOT NULL DEFAULT 'unknown',
  "actorName" text,
  "severity" text NOT NULL DEFAULT 'Normal' CHECK ("severity" IN ('Normal', 'Suspicious', 'High', 'Critical')),
  "riskScore" integer NOT NULL DEFAULT 0 CHECK ("riskScore" BETWEEN 0 AND 100),
  "riskExplanation" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'Open' CHECK ("status" IN ('Open', 'Contained', 'Monitoring', 'Resolved', 'FalsePositive')),
  "firstDetectedAt" timestamptz NOT NULL,
  "lastDetectedAt" timestamptz NOT NULL,
  "actionCount" integer NOT NULL DEFAULT 0,
  "trustedActor" boolean NOT NULL DEFAULT false,
  "guildOwner" boolean NOT NULL DEFAULT false,
  "selfActor" boolean NOT NULL DEFAULT false,
  "containmentStatus" text NOT NULL DEFAULT 'not_requested',
  "resolution" text,
  "resolutionReason" text,
  "alertMessageId" text,
  "lastAlertedSeverity" text,
  "lastAlertedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "security_incident_guild_status_detected_idx" ON "security_incident" ("guildId", "status", "lastDetectedAt" DESC);
CREATE INDEX IF NOT EXISTS "security_incident_guild_actor_detected_idx" ON "security_incident" ("guildId", "actorId", "lastDetectedAt" DESC);

CREATE TABLE IF NOT EXISTS "security_incident_action" (
  "id" serial PRIMARY KEY,
  "incidentId" text NOT NULL REFERENCES "security_incident"("id") ON DELETE CASCADE,
  "guildId" text NOT NULL,
  "auditLogEntryId" text NOT NULL UNIQUE,
  "actionType" text NOT NULL,
  "actorId" text,
  "targetId" text,
  "occurredAt" timestamptz NOT NULL,
  "riskWeight" integer NOT NULL DEFAULT 0,
  "destructive" boolean NOT NULL DEFAULT false,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "security_incident_action_incident_occurred_idx" ON "security_incident_action" ("incidentId", "occurredAt");
CREATE INDEX IF NOT EXISTS "security_incident_action_guild_actor_occurred_idx" ON "security_incident_action" ("guildId", "actorId", "occurredAt" DESC);

CREATE TABLE IF NOT EXISTS "security_snapshot" (
  "id" text PRIMARY KEY,
  "guildId" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "schemaVersion" integer NOT NULL DEFAULT 1,
  "checksum" text NOT NULL,
  "data" jsonb NOT NULL,
  "createdBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "security_snapshot_guild_created_idx" ON "security_snapshot" ("guildId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS "security_audit_event" (
  "id" serial PRIMARY KEY,
  "guildId" text NOT NULL,
  "incidentId" text,
  "eventType" text NOT NULL,
  "actorId" text,
  "actorName" text,
  "source" text NOT NULL DEFAULT 'bot',
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "security_audit_event_guild_created_idx" ON "security_audit_event" ("guildId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "security_audit_event_incident_created_idx" ON "security_audit_event" ("incidentId", "createdAt");

CREATE TABLE IF NOT EXISTS "security_action_request" (
  "id" text PRIMARY KEY,
  "guildId" text NOT NULL,
  "incidentId" text,
  "action" text NOT NULL CHECK ("action" IN ('contain', 'snapshot', 'restore_preview')),
  "requestedBy" text NOT NULL,
  "requestedByName" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
  "result" jsonb,
  "errorCode" text,
  "errorMessage" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "claimedAt" timestamptz,
  "completedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "security_action_request_status_created_idx" ON "security_action_request" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "security_action_request_guild_created_idx" ON "security_action_request" ("guildId", "createdAt" DESC);
