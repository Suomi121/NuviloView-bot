ALTER TABLE "security_policy"
  ADD COLUMN IF NOT EXISTS "channelProtection" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "roleProtection" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "autoRestore" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "webhookProtection" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "botSpamProtection" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "botDuplicateSpam" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "botEveryoneSpam" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "detectorThresholds" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "missingPermissions" jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'security_policy'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) ILIKE '%mode%shadow%manual%'
        OR pg_get_constraintdef(oid) ILIKE '%automaticContainment%false%'
      )
  LOOP
    EXECUTE format('ALTER TABLE "security_policy" DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE "security_policy"
  ADD CONSTRAINT "security_policy_mode_security_v1_check"
  CHECK ("mode" IN ('shadow', 'monitor', 'manual', 'protect', 'strict'));

ALTER TABLE "security_incident"
  ADD COLUMN IF NOT EXISTS "incidentType" text,
  ADD COLUMN IF NOT EXISTS "actionTaken" jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS "security_incident_guild_type_detected_idx"
  ON "security_incident" ("guildId", "incidentType", "lastDetectedAt" DESC);
