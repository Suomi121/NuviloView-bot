-- Better Auth 1.6: external identity ownership is provider-scoped, not user-scoped.
-- Additive Auth-only migration. Never run via the legacy Bot/Neon migration set.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Close the audit-to-DDL race, including against an older application instance.
LOCK TABLE public.account IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  identity_columns smallint[];
  duplicate_groups bigint;
BEGIN
  SELECT array_agg(attnum ORDER BY CASE attname WHEN 'providerId' THEN 1 ELSE 2 END)
    INTO identity_columns
    FROM pg_attribute
    WHERE attrelid = 'public.account'::regclass
      AND attname IN ('providerId', 'accountId')
      AND attnotnull AND NOT attisdropped;
  IF cardinality(identity_columns) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Auth identity schema must have both required NOT NULL columns';
  END IF;

  SELECT count(*) INTO duplicate_groups FROM (
    SELECT 1 FROM public.account GROUP BY "providerId", "accountId" HAVING count(*) > 1
  ) duplicates;
  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Auth identity duplicates require a separately reviewed repair plan';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.account'::regclass AND conname = 'account_provider_identity_unique'
  ) THEN
    ALTER TABLE public.account ADD CONSTRAINT account_provider_identity_unique
      UNIQUE ("providerId", "accountId");
  END IF;
  -- A same-name but wrong/deferred/invalid structure is not an applied migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
    WHERE c.conrelid = 'public.account'::regclass
      AND c.conname = 'account_provider_identity_unique'
      AND c.contype = 'u' AND c.conkey = identity_columns
      AND NOT c.condeferrable AND c.convalidated
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Auth identity constraint does not match the required ownership contract';
  END IF;
END
$migration$;
COMMIT;
