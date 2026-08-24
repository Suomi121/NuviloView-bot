import { createHash } from "node:crypto";

const migrationHistorySql = `
  CREATE TABLE IF NOT EXISTS migration_history (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT;
`;

const initialSchemaSql = `
  CREATE TABLE IF NOT EXISTS storage_meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_events (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'delete')),
    content TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (guild_id, message_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS message_events_guild_occurred_idx
    ON message_events (guild_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS message_events_channel_occurred_idx
    ON message_events (channel_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS reaction_events (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS reaction_events_guild_occurred_idx
    ON reaction_events (guild_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS reaction_events_message_idx
    ON reaction_events (message_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS voice_events (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('join', 'move', 'leave')),
    previous_channel_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS voice_events_guild_occurred_idx
    ON voice_events (guild_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS voice_events_session_idx
    ON voice_events (session_id, occurred_at);

  CREATE TABLE IF NOT EXISTS member_events (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('join', 'leave', 'update', 'sync')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS member_events_guild_occurred_idx
    ON member_events (guild_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS member_events_user_occurred_idx
    ON member_events (user_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS security_audit (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    incident_id TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    action TEXT NOT NULL,
    actor_id TEXT,
    target_id TEXT,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS security_audit_guild_occurred_idx
    ON security_audit (guild_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS security_audit_incident_idx
    ON security_audit (incident_id) WHERE incident_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS local_guild_config (
    guild_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    policy_json TEXT NOT NULL DEFAULT '{}',
    source_updated_at INTEGER,
    cached_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sync_metadata (
    stream_name TEXT PRIMARY KEY,
    cursor_value TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

const syncPipelineSchemaSql = `
  CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL CHECK (
      domain IN ('bot_event', 'analytics', 'security', 'moderation', 'inventory', 'history', 'health')
    ),
    event_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'processing', 'retry', 'synced', 'dead_letter')
    ),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    locked_at INTEGER,
    locked_by TEXT,
    first_failed_at INTEGER,
    last_attempt_at INTEGER,
    last_error TEXT,
    synced_at INTEGER,
    checksum TEXT NOT NULL,
    CHECK (
      (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
      OR status <> 'processing'
    )
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sync_outbox_claim_idx
    ON sync_outbox (status, available_at, priority DESC, created_at)
    WHERE status IN ('pending', 'retry');
  CREATE INDEX IF NOT EXISTS sync_outbox_lock_idx
    ON sync_outbox (status, locked_at)
    WHERE status = 'processing';
  CREATE INDEX IF NOT EXISTS sync_outbox_status_created_idx
    ON sync_outbox (status, created_at);

  CREATE TABLE IF NOT EXISTS sync_dead_letter (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    source_outbox_id TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL,
    event_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    error TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    first_failed_at INTEGER NOT NULL,
    last_failed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    requeued_at INTEGER,
    requeue_count INTEGER NOT NULL DEFAULT 0 CHECK (requeue_count >= 0)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sync_dead_letter_failed_idx
    ON sync_dead_letter (last_failed_at DESC);
`;

const messageLocalFirstSchemaSql = `
  ALTER TABLE message_events ADD COLUMN revision TEXT;
  ALTER TABLE message_events ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE message_events ADD COLUMN event_rank INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE message_events ADD COLUMN current_event_id TEXT;
  ALTER TABLE message_events ADD COLUMN content_checksum TEXT;
  ALTER TABLE message_events ADD COLUMN delete_event_id TEXT;

  CREATE TABLE IF NOT EXISTS message_event_log (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'delete')),
    revision TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    event_rank INTEGER NOT NULL CHECK (event_rank BETWEEN 0 AND 2),
    content TEXT,
    content_checksum TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS message_event_log_message_order_idx
    ON message_event_log (
      guild_id, message_id, source_sequence, event_rank, revision
    );
  CREATE INDEX IF NOT EXISTS message_event_log_guild_occurred_idx
    ON message_event_log (guild_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS local_message_daily_stats (
    guild_id TEXT NOT NULL,
    date_utc TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    member_count INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, date_utc)
  ) WITHOUT ROWID, STRICT;

  CREATE TABLE IF NOT EXISTS local_message_active_member (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    date_utc TEXT NOT NULL,
    first_message_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 1 CHECK (message_count > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, date_utc)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS local_message_active_member_date_idx
    ON local_message_active_member (guild_id, date_utc);

  CREATE TABLE IF NOT EXISTS local_message_recent_activity (
    event_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS local_message_recent_activity_guild_idx
    ON local_message_recent_activity (guild_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS message_domain_metrics (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    local_writes_total INTEGER NOT NULL DEFAULT 0,
    local_write_failures INTEGER NOT NULL DEFAULT 0,
    sync_success_total INTEGER NOT NULL DEFAULT 0,
    sync_failure_total INTEGER NOT NULL DEFAULT 0,
    last_local_write_at INTEGER,
    last_local_write_failure_at INTEGER,
    last_sync_at INTEGER,
    last_sync_failure_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO message_domain_metrics (id, updated_at) VALUES (1, 0);
`;

const multiDbSyncSchemaSql = `
  CREATE TABLE IF NOT EXISTS sync_provider_delivery (
    event_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK (provider_id IN ('supabase', 'turso', 'neon')),
    provider_required INTEGER NOT NULL CHECK (provider_required IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'processing', 'retry', 'synced', 'dead_letter', 'disabled')
    ),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at INTEGER NOT NULL,
    locked_at INTEGER,
    locked_by TEXT,
    first_failed_at INTEGER,
    last_attempt_at INTEGER,
    last_error TEXT,
    synced_at INTEGER,
    remote_checksum TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, provider_id),
    FOREIGN KEY (event_id) REFERENCES sync_outbox(event_id) ON DELETE CASCADE,
    CHECK (
      (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
      OR status <> 'processing'
    )
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS sync_provider_delivery_claim_idx
    ON sync_provider_delivery (provider_id, status, available_at, created_at)
    WHERE status IN ('pending', 'retry');
  CREATE INDEX IF NOT EXISTS sync_provider_delivery_lock_idx
    ON sync_provider_delivery (provider_id, status, locked_at)
    WHERE status = 'processing';
  CREATE INDEX IF NOT EXISTS sync_provider_delivery_status_idx
    ON sync_provider_delivery (provider_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS sync_provider_metrics (
    provider_id TEXT PRIMARY KEY CHECK (provider_id IN ('supabase', 'turso', 'neon')),
    provider_required INTEGER NOT NULL CHECK (provider_required IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    health_status TEXT NOT NULL DEFAULT 'DISABLED',
    circuit_state TEXT NOT NULL DEFAULT 'CLOSED',
    query_count INTEGER NOT NULL DEFAULT 0 CHECK (query_count >= 0),
    synced_total INTEGER NOT NULL DEFAULT 0 CHECK (synced_total >= 0),
    failed_total INTEGER NOT NULL DEFAULT 0 CHECK (failed_total >= 0),
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    last_failure_at INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sync_snapshot (
    snapshot_type TEXT NOT NULL CHECK (
      snapshot_type IN ('guild_status', 'analytics', 'runtime', 'sync_status')
    ),
    aggregate_id TEXT NOT NULL,
    snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
    payload_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
    generated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (snapshot_type, aggregate_id)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS sync_snapshot_dirty_idx
    ON sync_snapshot (dirty, updated_at) WHERE dirty = 1;

  CREATE TABLE IF NOT EXISTS sync_provider_snapshot_delivery (
    snapshot_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK (provider_id IN ('supabase', 'turso', 'neon')),
    provider_required INTEGER NOT NULL CHECK (provider_required IN (0, 1)),
    snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
    checksum TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'processing', 'retry', 'synced', 'dead_letter', 'disabled')
    ),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at INTEGER NOT NULL,
    locked_at INTEGER,
    locked_by TEXT,
    first_failed_at INTEGER,
    last_attempt_at INTEGER,
    last_error TEXT,
    synced_at INTEGER,
    remote_checksum TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (snapshot_type, aggregate_id, provider_id),
    FOREIGN KEY (snapshot_type, aggregate_id)
      REFERENCES sync_snapshot(snapshot_type, aggregate_id) ON DELETE CASCADE,
    CHECK (
      (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
      OR status <> 'processing'
    )
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS sync_provider_snapshot_claim_idx
    ON sync_provider_snapshot_delivery (
      provider_id, status, available_at, updated_at
    ) WHERE status IN ('pending', 'retry');
  CREATE INDEX IF NOT EXISTS sync_provider_snapshot_lock_idx
    ON sync_provider_snapshot_delivery (provider_id, status, locked_at)
    WHERE status = 'processing';
`;

function checksum(sql) {
  return createHash("sha256").update(sql.replace(/\r\n?/g, "\n")).digest("hex");
}

export const localStorageMigrations = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial-local-storage",
    sql: initialSchemaSql,
    checksum: checksum(initialSchemaSql),
  }),
  Object.freeze({
    version: 2,
    name: "sync-outbox-and-dead-letter",
    sql: syncPipelineSchemaSql,
    checksum: checksum(syncPipelineSchemaSql),
  }),
  Object.freeze({
    version: 3,
    name: "message-domain-local-first",
    sql: messageLocalFirstSchemaSql,
    checksum: checksum(messageLocalFirstSchemaSql),
  }),
  Object.freeze({
    version: 4,
    name: "multi-db-provider-delivery-and-snapshots",
    sql: multiDbSyncSchemaSql,
    checksum: checksum(multiDbSyncSchemaSql),
  }),
]);

export function applyLocalStorageMigrations(database, { now = () => Date.now() } = {}) {
  database.exec(migrationHistorySql);
  const appliedRows = database
    .prepare("SELECT version, name, checksum FROM migration_history ORDER BY version")
    .all();
  const applied = new Map(appliedRows.map((row) => [Number(row.version), row]));
  const appliedNow = [];

  for (const migration of localStorageMigrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
        throw new Error(
          `Local migration ${migration.version} does not match its applied checksum.`,
        );
      }
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      const appliedAt = now();
      database
        .prepare(
          `INSERT INTO migration_history (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(migration.version, migration.name, migration.checksum, appliedAt);
      database
        .prepare(
          `INSERT INTO storage_meta (key, value_json, updated_at)
           VALUES ('schema_version', ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(migration.version), appliedAt);
      database.exec("COMMIT");
      appliedNow.push(migration.version);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error.
      }
      throw error;
    }
  }

  return {
    currentVersion: localStorageMigrations.at(-1)?.version ?? 0,
    appliedNow,
  };
}
