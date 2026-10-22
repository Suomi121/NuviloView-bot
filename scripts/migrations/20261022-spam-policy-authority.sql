-- Schema only. No Guild is transferred by applying this migration.
CREATE TABLE IF NOT EXISTS "guild_spam_policy_authority" (
  "guild_id" text PRIMARY KEY,
  "writer_id" text NOT NULL,
  "epoch" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION guard_spam_policy_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Old repeatable-read snapshots cannot prove that no fence was committed.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SPAM_AUTHORITY_REQUIRES_READ_COMMITTED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM guild_spam_policy_authority WHERE guild_id IN (NEW.guild_id, OLD.guild_id)) THEN
    RAISE EXCEPTION 'SPAM_POLICY_SQLITE_AUTHORITY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER spam_policy_authority_fence
BEFORE INSERT OR UPDATE OR DELETE ON guild_spam_policy
FOR EACH ROW EXECUTE FUNCTION guard_spam_policy_authority();

CREATE OR REPLACE FUNCTION guard_spam_auto_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SPAM_AUTHORITY_REQUIRES_READ_COMMITTED' USING ERRCODE = '55000';
  END IF;
  IF NEW.enabled AND EXISTS (SELECT 1 FROM guild_spam_policy_authority WHERE guild_id = NEW.guild_id) THEN
    RAISE EXCEPTION 'SPAM_AUTO_SQLITE_AUTHORITY_DENIED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER spam_auto_authority_fence
BEFORE INSERT OR UPDATE ON guild_security_v2_auto
FOR EACH ROW EXECUTE FUNCTION guard_spam_auto_authority();

CREATE OR REPLACE FUNCTION guard_spam_policy_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SPAM_AUTHORITY_REQUIRES_READ_COMMITTED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM guild_spam_policy_authority) THEN
    RAISE EXCEPTION 'SPAM_POLICY_SQLITE_AUTHORITY' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER spam_policy_authority_truncate_fence
BEFORE TRUNCATE ON guild_spam_policy
FOR EACH STATEMENT EXECUTE FUNCTION guard_spam_policy_truncate();
