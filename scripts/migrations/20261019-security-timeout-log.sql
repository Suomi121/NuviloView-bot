CREATE TABLE guild_security_log (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{16,22}$'),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^[0-9]{16,22}$'),
  updated_by text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guild_security_log_audit (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guild_security_log(guild_id),
  channel_id text,
  actor_id text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, revision)
);
CREATE INDEX guild_security_log_audit_guild_created_idx ON guild_security_log_audit(guild_id, created_at);
