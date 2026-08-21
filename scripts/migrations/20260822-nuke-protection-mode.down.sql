ALTER TABLE "security_policy"
  DROP CONSTRAINT IF EXISTS "security_policy_nuke_protection_mode_check",
  DROP COLUMN IF EXISTS "nukeProtectionMode";
