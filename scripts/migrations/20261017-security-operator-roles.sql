CREATE TABLE guild_security_operator (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{16,22}$'),
  role_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(role_ids) <= 20),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guild_security_operator_audit (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guild_security_operator(guild_id),
  actor_id text NOT NULL,
  role_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('add', 'remove')),
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, revision)
);
CREATE INDEX guild_security_operator_audit_guild_created_idx ON guild_security_operator_audit(guild_id, created_at);
