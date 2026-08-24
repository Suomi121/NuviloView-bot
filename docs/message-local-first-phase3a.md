# Phase 3A: Message Domain Local-First

Status: implemented behind a default-OFF feature flag. Production has not been changed.

## Routing

- `LOCAL_MESSAGE_STORAGE_ENABLED=false`: the existing Neon Message path is used.
- `LOCAL_MESSAGE_STORAGE_ENABLED=true`: Message Create, Update, Delete, Daily Stats,
  Active Member, and Recent Activity are written to SQLite plus Outbox in one
  synchronous transaction. No Message write falls back to Neon.
- Reaction, Voice, Member, Inventory, Security, Moderation, History Import, Web,
  OAuth, and Vercel APIs keep their existing storage paths.

Local-first mode also requires:

```ini
LOCAL_STORAGE_ENABLED=true
LOCAL_STORAGE_WRITE_ENABLED=true
LOCAL_MESSAGE_STORAGE_ENABLED=true
```

The Sync Worker remains independently controlled by
`SYNC_WORKER_ENABLED` and `SYNC_NEON_REPLICA_ENABLED`.

## Event and ordering model

- Create: `message-create:{guildId}:{messageId}`
- Update: `message-update:{guildId}:{messageId}:{editedTimestamp + content SHA-256}`
- Delete: `message-delete:{guildId}:{messageId}`

`message_event_log` is append-only. `message_events` is the current local read
model. A current row changes only when `(source_sequence, event_rank, revision)`
is newer. Event ranks are Create 0, Update 1, Delete 2. Delete keeps a Tombstone
with `deleted_at` and `delete_event_id`; it never relies only on a physical delete.

## Existing Neon query reduction

Before cutover, one normal Message Create performs up to four Neon writes:

1. `daily_stats`
2. `recent_activity`
3. `daily_active_member`
4. `discord_message`

A delete performs a Message lookup and a delete. With local-first routing ON,
the gateway handler performs no Neon Message write. One local transaction stores
the event, current read model, derived local values, and one Outbox envelope.
The separate Worker later sends a bounded batch to `sync_message_event_batch`.

## Replica proposal

[`docs/sql/phase3a-message-replica-proposal.sql`](sql/phase3a-message-replica-proposal.sql)
is a review-only additive PostgreSQL proposal. It has not been added to the active
migration manifest and has not been applied to any database. It provides:

- immutable Event ID/checksum storage;
- deterministic current-message materialization;
- delete ordering that also considers Tombstones from earlier batches;
- idempotent Active Member and Recent Activity materialization;
- a one-time legacy Daily Stats baseline plus absolute event-count recomputation.

## Safe rollback

The current routing mode is stored in local `sync_metadata`. Starting the Bot with
Message local-first OFF is rejected when the previous mode was local-first and a
Message Outbox item is still pending, retrying, or processing.

The emergency override is:

```ini
LOCAL_MESSAGE_STORAGE_FORCE_LEGACY_WITH_PENDING=true
```

It must not be used until the pending events have been reconciled. It is explicit,
logs only the count, and never prints Message content.

Normal rollback procedure:

1. Stop new local Message ingestion.
2. Keep the Sync Worker running until Message pending count reaches zero.
3. Verify the last Message sync time and replica counts.
4. Set `LOCAL_MESSAGE_STORAGE_ENABLED=false` and restart only in an approved rollout.

## Retention and health

`SYNC_OUTBOX_RETENTION_DAYS=7` removes only expired `synced` rows, in bounded
batches. Pending, Retry, Processing, and Dead Letter data are never removed by this
cleanup.

The existing local Worker health snapshot now includes:

- `messageLocalWritesTotal`
- `messageLocalWriteFailures`
- `messageOutboxPending`
- `messageSyncSuccessTotal`
- `messageSyncFailureTotal`
- `messageLastLocalWrite`
- `messageLastSync`
- `messageSyncLag`
- `messageOldestPendingAge`

This avoids adding a polling query to Neon.

