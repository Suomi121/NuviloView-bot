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
migration manifest and has not been applied to Production. It provides:

- immutable Event ID/checksum storage;
- deterministic current-message materialization;
- delete ordering that also considers Tombstones from earlier batches;
- idempotent Active Member and Recent Activity materialization;
- a one-time legacy Daily Stats baseline plus absolute event-count recomputation.

## Isolated PostgreSQL verification

Validated on 2026-08-24 against a disposable Docker PostgreSQL 17.11 database
bound only to `127.0.0.1`. The test used `TEST_REPLICA_DATABASE_URL`; neither
`DATABASE_URL` nor any Production credential was loaded. The container and its
data were deleted after validation.

The verification found and corrected three proposal-only issues before any
Production rollout:

- a PostgreSQL alias syntax error in the function's return query;
- no explicit cloud Tombstone read model for `deletedAt` / `deleteEventId`;
- update materialization used receipt time instead of the Discord event edit time.

An aggregate/order index was also added for the exact
`sourceSequence -> eventRank -> revision` winner lookup. The isolated schema
checks passed for tables, indexes, primary/unique/foreign-key constraints,
`timestamptz`, JSONB, unbounded text Event IDs, the PL/pgSQL function, and the
existing Dashboard tables.

Functional results:

- Create / Update / Delete / Tombstone: PASS
- `Update -> Create`, `Delete -> Update -> Create`,
  `Create -> Delete -> Update`, `Update v2 -> Update v1`: PASS
- identical batch delivered three times: no duplicate events, messages,
  daily counts, activity rows, or active members
- legacy Daily Stats value 7 plus 100 unique Creates produced 107 after retries
- 100 messages from one member produced one active-member row per UTC day;
  a 23:59:59Z / 00:00:00Z boundary produced the expected two dates
- invalid mixed batches rolled back atomically; no partial materialization remained
- connection failure and timeout classified transient; constraints and invalid
  payloads classified permanent; checksum reuse with different content was rejected
- Circuit transitioned `CLOSED -> OPEN -> HALF_OPEN -> CLOSED`; permanent failure
  moved to Dead Letter without opening the Circuit
- migration rerun retained all data; an injected failure left no partial schema
- rollback proposal removed only the replica function/tables/indexes and retained
  existing Dashboard tables and additive provenance columns

Network-level query counts were one PostgreSQL call per batch: 25, 50, and 100
events each used one call. Therefore 100 messages at batch size 25 used four
calls, while 1,000 messages at batch size 100 used ten. Each call executes the
materialization statements inside one server-side function/transaction; these are
not extra network round trips.

Measured on the disposable local container:

| Events | Batch | Calls | First sync | Duplicate retry | Replica size increase |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 25 | 4 | 29.20 ms | 23.21 ms | 81,920 bytes |
| 1,000 | 100 | 10 | 185.05 ms | 157.99 ms | 1,187,840 bytes |

`EXPLAIN (ANALYZE, BUFFERS)` confirmed an Index Scan for the aggregate winner
lookup. These timings are local functional measurements, not Production capacity
claims.

The executable integration test is
[`tests/message-replica-postgres.test.mjs`](../tests/message-replica-postgres.test.mjs).
It is skipped by the normal suite unless the isolated test variable is set:

```powershell
$env:TEST_REPLICA_DATABASE_URL = '<isolated-test-postgresql-url>'
corepack pnpm test:replica:postgres
```

Never point this variable at Production. The reviewed rollback proposal is
[`docs/sql/phase3a-message-replica-rollback.sql`](sql/phase3a-message-replica-rollback.sql).

## Production rollout blockers

- Review the proposal and destructive parts of rollback independently.
- Capture a fresh Production schema diff before creating a formal migration.
- Decide whether retained additive provenance columns are acceptable on rollback.
- Run a staging canary with realistic legacy Daily Stats and imported messages.
- Approve migration, flags, worker rollout, monitoring, and rollback as separate steps.

Phase 3B Reaction Local-First is intentionally out of scope and has not started.

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
