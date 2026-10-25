-- Schema/fences only. No membership, Guild enrollment or consent is changed.
-- All old Web writers AND Discord punishers must be drained before import.
CREATE TABLE IF NOT EXISTS "mdb_membership" (
  "singleton" integer PRIMARY KEY CHECK (singleton = 1), "membership" text NOT NULL, "provider_id" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "mdb_acceptor" (
  "guild_id" text NOT NULL, "slot" integer NOT NULL CHECK (slot > 0), "promised" text NOT NULL,
  "accepted_ballot" text, "value" text, "checksum" text,
  PRIMARY KEY (guild_id, slot),
  CHECK ((accepted_ballot IS NULL AND value IS NULL AND checksum IS NULL) OR
    (accepted_ballot IS NOT NULL AND value IS NOT NULL AND checksum IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS "guild_security_quorum_fence" (
  "guild_id" text PRIMARY KEY, "epoch" text NOT NULL, "snapshot_checksum" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION guard_security_quorum_writer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'QUORUM_FENCE_REQUIRES_READ_COMMITTED' USING ERRCODE = '55000';
  END IF;
  IF TG_LEVEL = 'STATEMENT' OR TG_TABLE_NAME = 'security_v2_control' THEN
    IF EXISTS (SELECT 1 FROM guild_security_quorum_fence) THEN
      RAISE EXCEPTION 'SECURITY_QUORUM_AUTHORITY' USING ERRCODE = '55000';
    END IF;
    IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
  ELSIF EXISTS (SELECT 1 FROM guild_security_quorum_fence WHERE guild_id IN (NEW.guild_id, OLD.guild_id)) THEN
    RAISE EXCEPTION 'SECURITY_QUORUM_AUTHORITY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quorum_policy_writer BEFORE INSERT OR UPDATE OR DELETE ON guild_spam_policy
FOR EACH ROW EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_auto_writer BEFORE INSERT OR UPDATE OR DELETE ON guild_security_v2_auto
FOR EACH ROW EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_enrollment_writer BEFORE INSERT OR UPDATE OR DELETE ON guild_security_v2_enrollment
FOR EACH ROW EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_operator_writer BEFORE INSERT OR UPDATE OR DELETE ON guild_security_operator
FOR EACH ROW EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_log_writer BEFORE INSERT OR UPDATE OR DELETE ON guild_security_log
FOR EACH ROW EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_control_writer BEFORE INSERT OR UPDATE OR DELETE ON security_v2_control
FOR EACH ROW EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_policy_truncate BEFORE TRUNCATE ON guild_spam_policy
FOR EACH STATEMENT EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_auto_truncate BEFORE TRUNCATE ON guild_security_v2_auto
FOR EACH STATEMENT EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_enrollment_truncate BEFORE TRUNCATE ON guild_security_v2_enrollment
FOR EACH STATEMENT EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_operator_truncate BEFORE TRUNCATE ON guild_security_operator
FOR EACH STATEMENT EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_log_truncate BEFORE TRUNCATE ON guild_security_log
FOR EACH STATEMENT EXECUTE FUNCTION guard_security_quorum_writer();
CREATE TRIGGER quorum_control_truncate BEFORE TRUNCATE ON security_v2_control
FOR EACH STATEMENT EXECUTE FUNCTION guard_security_quorum_writer();
