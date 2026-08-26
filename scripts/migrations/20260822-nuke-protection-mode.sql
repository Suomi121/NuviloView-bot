ALTER TABLE "security_policy"
  ADD COLUMN IF NOT EXISTS "nukeProtectionMode" text NOT NULL DEFAULT 'shadow';

UPDATE "security_policy"
SET "nukeProtectionMode" = 'shadow'
WHERE "nukeProtectionMode" NOT IN ('off', 'shadow', 'active');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'security_policy_nuke_protection_mode_check'
      AND conrelid = 'security_policy'::regclass
  ) THEN
    ALTER TABLE "security_policy"
      ADD CONSTRAINT "security_policy_nuke_protection_mode_check"
      CHECK ("nukeProtectionMode" IN ('off', 'shadow', 'active'));
  END IF;
END
$$;
