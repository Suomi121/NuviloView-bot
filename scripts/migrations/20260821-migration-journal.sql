CREATE TABLE IF NOT EXISTS "schema_migration" (
  "id" text PRIMARY KEY,
  "checksum" text NOT NULL,
  "description" text NOT NULL,
  "risk" text NOT NULL,
  "appliedAt" timestamptz NOT NULL DEFAULT now(),
  "appliedBy" text NOT NULL,
  CONSTRAINT "schema_migration_risk_check"
    CHECK ("risk" IN ('low', 'medium', 'high'))
);
