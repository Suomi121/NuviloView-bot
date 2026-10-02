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

const analyticsCompactionSchemaSql = `
  CREATE TABLE IF NOT EXISTS analytics_projection_dirty (
    projection_key TEXT PRIMARY KEY,
    projection_kind TEXT NOT NULL CHECK (
      projection_kind IN ('guild_current', 'guild_daily', 'channel_daily', 'user_daily')
    ),
    guild_id TEXT NOT NULL,
    date_utc TEXT,
    channel_id TEXT,
    user_id TEXT,
    source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence >= 0),
    last_aggregated_sequence INTEGER NOT NULL DEFAULT 0
      CHECK (last_aggregated_sequence >= 0),
    dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
    next_eligible_at INTEGER NOT NULL,
    last_event_at INTEGER,
    last_aggregated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS analytics_projection_dirty_claim_idx
    ON analytics_projection_dirty (dirty, next_eligible_at, updated_at)
    WHERE dirty = 1;
  CREATE INDEX IF NOT EXISTS analytics_projection_dirty_guild_idx
    ON analytics_projection_dirty (guild_id, projection_kind, date_utc);

  CREATE TABLE IF NOT EXISTS analytics_compaction_metrics (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    raw_events_seen INTEGER NOT NULL DEFAULT 0 CHECK (raw_events_seen >= 0),
    snapshots_built INTEGER NOT NULL DEFAULT 0 CHECK (snapshots_built >= 0),
    snapshots_changed INTEGER NOT NULL DEFAULT 0 CHECK (snapshots_changed >= 0),
    snapshots_skipped INTEGER NOT NULL DEFAULT 0 CHECK (snapshots_skipped >= 0),
    provider_writes INTEGER NOT NULL DEFAULT 0 CHECK (provider_writes >= 0),
    supabase_writes INTEGER NOT NULL DEFAULT 0 CHECK (supabase_writes >= 0),
    turso_writes INTEGER NOT NULL DEFAULT 0 CHECK (turso_writes >= 0),
    neon_writes INTEGER NOT NULL DEFAULT 0 CHECK (neon_writes >= 0),
    last_built_at INTEGER,
    last_provider_write_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO analytics_compaction_metrics (id, updated_at)
    VALUES (1, 0);
`;

const historyImportSqliteFirstSchemaSql = `
  ALTER TABLE message_event_log ADD COLUMN source TEXT NOT NULL DEFAULT 'existing'
    CHECK (source IN ('existing', 'live', 'history_import'));
  ALTER TABLE message_event_log ADD COLUMN source_rank INTEGER NOT NULL DEFAULT 1
    CHECK (source_rank BETWEEN 0 AND 2);
  ALTER TABLE message_event_log ADD COLUMN import_job_id TEXT;

  ALTER TABLE message_events ADD COLUMN source TEXT NOT NULL DEFAULT 'existing'
    CHECK (source IN ('existing', 'live', 'history_import'));
  ALTER TABLE message_events ADD COLUMN source_rank INTEGER NOT NULL DEFAULT 1
    CHECK (source_rank BETWEEN 0 AND 2);
  ALTER TABLE message_events ADD COLUMN import_job_id TEXT;

  UPDATE message_event_log
  SET source = CASE
        WHEN json_extract(payload_json, '$.source') = 'live' THEN 'live'
        ELSE 'existing'
      END,
      source_rank = CASE
        WHEN json_extract(payload_json, '$.source') = 'live' THEN 2
        ELSE 1
      END;
  UPDATE message_events
  SET source = CASE
        WHEN json_extract(payload_json, '$.source') = 'live' THEN 'live'
        ELSE 'existing'
      END,
      source_rank = CASE
        WHEN json_extract(payload_json, '$.source') = 'live' THEN 2
        ELSE 1
      END;

  CREATE INDEX IF NOT EXISTS message_event_log_guild_source_idx
    ON message_event_log (guild_id, source, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS message_events_guild_source_idx
    ON message_events (guild_id, source, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS message_event_log_import_job_idx
    ON message_event_log (import_job_id, guild_id)
    WHERE import_job_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS history_import_local_job (
    job_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'preparing', 'running', 'pausing', 'paused', 'cancelling',
      'cancelled', 'completed', 'failed', 'stalled'
    )),
    fetched_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
    eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
    inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    current_channel_id TEXT,
    retry_state TEXT,
    retry_after_at INTEGER,
    last_checkpoint_at INTEGER,
    last_heartbeat_at INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS history_import_local_job_guild_idx
    ON history_import_local_job (guild_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS history_import_local_channel (
    job_id TEXT NOT NULL,
    channel_progress_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    status TEXT NOT NULL,
    next_before_message_id TEXT,
    oldest_message_id TEXT,
    fetched_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
    eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
    inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    retry_after_at INTEGER,
    last_progress_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, channel_id),
    UNIQUE (job_id, channel_progress_id),
    FOREIGN KEY (job_id) REFERENCES history_import_local_job(job_id)
      ON DELETE CASCADE
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS history_import_local_channel_status_idx
    ON history_import_local_channel (job_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS history_import_local_batch (
    batch_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    channel_progress_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    request_before_message_id TEXT,
    next_before_message_id TEXT,
    oldest_message_id TEXT,
    fetched_count INTEGER NOT NULL CHECK (fetched_count >= 0),
    eligible_count INTEGER NOT NULL CHECK (eligible_count >= 0),
    inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
    duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES history_import_local_job(job_id)
      ON DELETE CASCADE
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS history_import_local_batch_job_idx
    ON history_import_local_batch (job_id, channel_progress_id, created_at);

  CREATE TABLE IF NOT EXISTS history_import_local_deletion (
    request_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    deleted_messages INTEGER NOT NULL CHECK (deleted_messages >= 0),
    deleted_at INTEGER NOT NULL
  ) WITHOUT ROWID, STRICT;
`;

const eventLocalFirstExpansionSchemaSql = `
  ALTER TABLE reaction_events ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE reaction_events ADD COLUMN revision TEXT;
  ALTER TABLE reaction_events ADD COLUMN recipient_id TEXT;
  ALTER TABLE reaction_events ADD COLUMN reactor_is_bot INTEGER NOT NULL DEFAULT 0
    CHECK (reactor_is_bot IN (0, 1));

  CREATE TABLE IF NOT EXISTS local_reaction_state (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji_key TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    recipient_id TEXT,
    reactor_is_bot INTEGER NOT NULL DEFAULT 0 CHECK (reactor_is_bot IN (0, 1)),
    last_event_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, message_id, user_id, emoji_key)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS local_reaction_state_guild_active_idx
    ON local_reaction_state (guild_id, active, updated_at);
  CREATE INDEX IF NOT EXISTS local_reaction_state_channel_active_idx
    ON local_reaction_state (guild_id, channel_id, active, updated_at);

  ALTER TABLE voice_events ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE voice_events ADD COLUMN started_at INTEGER;
  ALTER TABLE voice_events ADD COLUMN ended_at INTEGER;
  ALTER TABLE voice_events ADD COLUMN duration_seconds INTEGER;
  ALTER TABLE voice_events ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0
    CHECK (recovered IN (0, 1));
  ALTER TABLE voice_events ADD COLUMN recovery_reason TEXT;

  CREATE TABLE IF NOT EXISTS local_voice_session (
    session_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_seconds INTEGER,
    recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
    recovery_reason TEXT,
    role_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (ended_at IS NULL OR ended_at >= started_at),
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS local_voice_session_open_user_idx
    ON local_voice_session (guild_id, user_id) WHERE ended_at IS NULL;
  CREATE INDEX IF NOT EXISTS local_voice_session_guild_time_idx
    ON local_voice_session (guild_id, started_at, ended_at);
  CREATE INDEX IF NOT EXISTS local_voice_session_channel_time_idx
    ON local_voice_session (guild_id, channel_id, started_at, ended_at);
  CREATE INDEX IF NOT EXISTS voice_events_guild_user_sequence_idx
    ON voice_events (guild_id, user_id, source_sequence);

  ALTER TABLE member_events ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE member_events ADD COLUMN joined_at INTEGER;
  ALTER TABLE member_events ADD COLUMN left_at INTEGER;
  ALTER TABLE member_events ADD COLUMN role_hash TEXT;
  ALTER TABLE member_events ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0
    CHECK (is_bot IN (0, 1));

  CREATE TABLE IF NOT EXISTS local_member_state (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_present INTEGER NOT NULL CHECK (is_present IN (0, 1)),
    is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
    joined_at INTEGER,
    left_at INTEGER,
    role_hash TEXT,
    role_ids_json TEXT NOT NULL DEFAULT '[]',
    last_event_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS local_member_state_guild_present_idx
    ON local_member_state (guild_id, is_present, updated_at);

  CREATE TABLE IF NOT EXISTS local_member_guild_state (
    guild_id TEXT PRIMARY KEY,
    current_member_count INTEGER CHECK (current_member_count IS NULL OR current_member_count >= 0),
    source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence >= 0),
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID, STRICT;
`;

const retentionFoundationSchemaSql = `
  CREATE TABLE IF NOT EXISTS analytics_retention_foundation (
    projection_key TEXT PRIMARY KEY,
    projection_kind TEXT NOT NULL CHECK (
      projection_kind IN ('guild_current', 'guild_daily', 'channel_daily', 'user_daily')
    ),
    guild_id TEXT NOT NULL,
    date_utc TEXT,
    channel_id TEXT,
    user_id TEXT,
    state TEXT NOT NULL DEFAULT 'shadow' CHECK (
      state IN ('shadow', 'eligible', 'finalized', 'reopened', 'blocked')
    ),
    finalized_through_at INTEGER NOT NULL CHECK (finalized_through_at >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    snapshot_version INTEGER NOT NULL CHECK (snapshot_version >= 1),
    snapshot_checksum TEXT NOT NULL,
    baseline_material_json TEXT NOT NULL DEFAULT '{}',
    baseline_checksum TEXT,
    baseline_build_duration_ms REAL NOT NULL DEFAULT 0 CHECK (baseline_build_duration_ms >= 0),
    shadow_compare_count INTEGER NOT NULL DEFAULT 0 CHECK (shadow_compare_count >= 0),
    shadow_mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (shadow_mismatch_count >= 0),
    last_compared_at INTEGER,
    late_event_grace_until INTEGER NOT NULL CHECK (late_event_grace_until >= 0),
    reconciled_at INTEGER NOT NULL CHECK (reconciled_at >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (length(baseline_material_json) <= 65536),
    CHECK (
      (projection_kind = 'guild_current' AND date_utc IS NULL AND channel_id IS NULL AND user_id IS NULL)
      OR (projection_kind = 'guild_daily' AND date_utc IS NOT NULL AND channel_id IS NULL AND user_id IS NULL)
      OR (projection_kind = 'channel_daily' AND date_utc IS NOT NULL AND channel_id IS NOT NULL AND user_id IS NULL)
      OR (projection_kind = 'user_daily' AND date_utc IS NOT NULL AND channel_id IS NULL AND user_id IS NOT NULL)
    )
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS analytics_retention_foundation_state_idx
    ON analytics_retention_foundation (state, finalized_through_at, guild_id);
  CREATE INDEX IF NOT EXISTS analytics_retention_foundation_guild_idx
    ON analytics_retention_foundation (guild_id, projection_kind, date_utc);

  CREATE TABLE IF NOT EXISTS retention_late_event_queue (
    event_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL CHECK (domain IN ('message', 'reaction', 'voice', 'member')),
    guild_id TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    payload_json TEXT NOT NULL DEFAULT '{}',
    checksum TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
      status IN ('queued', 'reviewing', 'resolved', 'ignored')
    ),
    reason TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    CHECK (length(payload_json) <= 262144)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS retention_late_event_queue_status_idx
    ON retention_late_event_queue (status, first_seen_at, guild_id);
  CREATE INDEX IF NOT EXISTS retention_late_event_queue_partition_idx
    ON retention_late_event_queue (domain, partition_key, source_sequence);
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
  Object.freeze({
    version: 5,
    name: "analytics-compaction-projection-v2",
    sql: analyticsCompactionSchemaSql,
    checksum: checksum(analyticsCompactionSchemaSql),
  }),
  Object.freeze({
    version: 6,
    name: "history-import-sqlite-first-v3",
    sql: historyImportSqliteFirstSchemaSql,
    checksum: checksum(historyImportSqliteFirstSchemaSql),
  }),
  Object.freeze({
    version: 7,
    name: "event-local-first-expansion-v1",
    sql: eventLocalFirstExpansionSchemaSql,
    checksum: checksum(eventLocalFirstExpansionSchemaSql),
  }),
  Object.freeze({
    version: 8,
    name: "retention-foundation-v1",
    sql: retentionFoundationSchemaSql,
    checksum: checksum(retentionFoundationSchemaSql),
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
