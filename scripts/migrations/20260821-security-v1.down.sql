DROP INDEX IF EXISTS "security_incident_guild_type_detected_idx";

ALTER TABLE "security_incident"
  DROP COLUMN IF EXISTS "actionTaken",
  DROP COLUMN IF EXISTS "incidentType";

ALTER TABLE "security_policy"
  DROP CONSTRAINT IF EXISTS "security_policy_mode_security_v1_check",
  DROP COLUMN IF EXISTS "missingPermissions",
  DROP COLUMN IF EXISTS "detectorThresholds",
  DROP COLUMN IF EXISTS "botEveryoneSpam",
  DROP COLUMN IF EXISTS "botDuplicateSpam",
  DROP COLUMN IF EXISTS "botSpamProtection",
  DROP COLUMN IF EXISTS "webhookProtection",
  DROP COLUMN IF EXISTS "autoRestore",
  DROP COLUMN IF EXISTS "roleProtection",
  DROP COLUMN IF EXISTS "channelProtection";
