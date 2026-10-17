-- Additive only. Existing detection policies and their audit records are untouched.
-- The old Bot DOES NOT honor this stop flag: stop/remove Moderate Members
-- permission from old instances before approving this migration/cutover.
CREATE TABLE security_v2_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  emergency_stop boolean NOT NULL DEFAULT true
);
INSERT INTO security_v2_control (singleton, emergency_stop) VALUES (true, true);

CREATE TABLE guild_security_v2_enrollment (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{16,22}$'),
  migration_state text NOT NULL DEFAULT 'pending' CHECK (migration_state IN ('pending', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE guild_security_v2_auto (
  guild_id text PRIMARY KEY REFERENCES guild_security_v2_enrollment(guild_id),
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guild_security_v2_audit (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guild_security_v2_enrollment(guild_id),
  enabled boolean NOT NULL,
  revision bigint NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, revision)
);
CREATE INDEX guild_security_v2_audit_guild_created_idx ON guild_security_v2_audit (guild_id, created_at);
-- Guilds without detection rows are discovered from the Bot's Guild inventory.
-- They are always OFF even before discovery; absence never authorizes punishment.
INSERT INTO guild_security_v2_enrollment (guild_id)
SELECT guild_id FROM guild_spam_policy;
