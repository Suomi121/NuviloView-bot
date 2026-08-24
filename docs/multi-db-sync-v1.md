# NuviloView Multi-DB Sync v1

## Status and safety boundary

Multi-DB Sync v1 is implemented behind `MULTI_DB_SYNC_ENABLED=false`. The
default runtime remains the existing Message Local-First / legacy Neon worker.
No Supabase, Turso, Neon, Vercel, or Production migration is performed by
installing this branch.

SQLite remains the only Bot-side source of truth:

```text
Discord event -> SQLite transaction -> Outbox -> Provider delivery rows
                                      -> Supabase (required)
                                      -> Turso (required)
                                      -> Neon (optional)
```

OAuth, Web sessions, user/developer authentication, support data, and private
user settings are not replicated by this feature.

## Provider policy

| Provider | Policy | Intended use |
| --- | --- | --- |
| Supabase | required | Web/read model and analytics snapshots |
| Turso | required | independent fallback and backup read model |
| Neon | optional | existing Message replica plus optional snapshots |

Each event has a row in `sync_provider_delivery` for every stable Provider ID.
Retry, lease, error, checksum, Dead Letter state, metrics, and Circuit state are
Provider-specific. Supabase failure therefore does not stop Turso, and Neon
failure cannot block Cloud Complete.

An event becomes Cloud Complete only when all required delivery rows are
`synced`. Retention can then remove its Outbox envelope after the configured
retention period. Optional Provider catch-up after retention must use retained
domain event logs, snapshots, or a new bounded backfill; v1's CLI backfills the
currently retained Outbox only.

## Local migration v4

SQLite migration 4 is additive and creates:

- `sync_provider_delivery`
- `sync_provider_metrics`
- `sync_snapshot`
- `sync_provider_snapshot_delivery`

Existing migrations 1-3 are immutable. Enabling Multi-DB causes a local event,
Outbox envelope, and Provider rows to commit in the same SQLite transaction.

## Cloud schemas

Review these scripts and apply them manually to isolated databases before any
canary:

- `docs/sql/multi-db-supabase-v1.sql`
- `docs/sql/multi-db-turso-v1.sql`

The PostgreSQL script may also supply the optional Neon snapshot read model.
Neither script is part of the Production migration runner.

The deliberately small Provider-neutral model contains `replica_event`,
`guild_status_snapshot`, `analytics_snapshot`, `runtime_snapshot`, and
`sync_status_snapshot`; it does not clone all application tables.

## Configuration

```env
MULTI_DB_SYNC_ENABLED=false

SYNC_SUPABASE_ENABLED=false
SUPABASE_DATABASE_URL=

SYNC_TURSO_ENABLED=false
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

SYNC_NEON_ENABLED=false

SYNC_SNAPSHOT_ENABLED=false
SYNC_SNAPSHOT_INTERVAL_MS=60000
SYNC_SNAPSHOT_BATCH_SIZE=25
MULTI_DB_WEB_READ_ENABLED=false
SYNC_PROVIDER_BATCH_MIN=25
SYNC_PROVIDER_BATCH_MAX=100
```

`SYNC_NEON_REPLICA_ENABLED` remains supported by the legacy Worker and as a
fallback for the new Neon flag. Credentials are server-side only. The Turso
runtime uses the fetch-only `@tursodatabase/serverless` package so Termux does
not need a native database addon.

## Snapshots and freshness

Snapshot generation is separately gated. It runs at a bounded interval, uses a
canonical checksum, and only increments `snapshot_version` when payload content
changes. Older or checksum-conflicting remote writes are rejected.

The Cloud Read Router checks Supabase first and returns immediately when fresh.
It consults Turso only when Supabase is unavailable/stale, then optional Neon.
Responses include `source`, `lastUpdated`, `dataAgeMs`, `fresh`, and
`cloudSyncDelayed`. The authenticated `/api/analytics/snapshot` route remains
unavailable until both snapshot and Web-read flags are explicitly enabled.

## Inspection, reconciliation, and backfill

Read-only reconciliation:

```bash
pnpm sync:reconcile -- --provider=supabase --limit=100
```

Backfill defaults to a plan and only queues retained Outbox events:

```bash
pnpm sync:backfill -- --provider=turso --limit=100
pnpm sync:backfill -- --provider=turso --limit=100 --execute --confirm=turso
```

The commands require one explicit Provider. They do not reset the queue, delete
events, overwrite SQLite from Cloud, or silently discard failures.

## Rollout order

1. Keep every new flag off and deploy code only to an isolated host.
2. Apply and verify each Cloud schema in an isolated test project.
3. Configure server-side credentials without printing them.
4. Enable Supabase and Turso in a non-Production worker and run reconciliation.
5. Test each Provider offline independently and verify its Circuit suppresses
   queries while other Providers continue.
6. Enable snapshots, then authenticated snapshot reads.
7. Approve a separate Production canary. Neon remains optional.

Rollback is switching `MULTI_DB_SYNC_ENABLED=false` and restarting only the
Sync Worker. Existing SQLite events and delivery history are retained.

## Deferred work

Donation Scheduler v1 remains a separate phase. Multi-DB Sync does not send
Discord messages, schedule donations, update Git, or auto-update Termux.
