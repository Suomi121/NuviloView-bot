-- Additive, approval-gated. No legacy settings, consent or evidence are modified.
CREATE TABLE IF NOT EXISTS "mdb_blob_shard" (
 artifact_id text NOT NULL, version text NOT NULL,
 shard_index integer NOT NULL CHECK (shard_index BETWEEN 0 AND 2),
 payload text NOT NULL, checksum text NOT NULL,
 PRIMARY KEY (artifact_id, version, shard_index)
);
CREATE TABLE IF NOT EXISTS "guild_quorum_transfer" (
 guild_id text PRIMARY KEY, epoch text NOT NULL, plan_checksum text NOT NULL,
 snapshot text NOT NULL, snapshot_checksum text NOT NULL,
 state text NOT NULL CHECK (state IN ('fenced','complete')),
 created_at timestamptz NOT NULL DEFAULT now()
);
