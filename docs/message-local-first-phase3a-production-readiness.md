# Phase 3A Production Migration Review and Canary Runbook

Status: preparation complete on `feat/local-first-message-phase3a`. Production
Migration, Production database writes, Bot restart, Vercel deployment, Feature
Flag changes, push, merge, and Phase 3B have not been performed.

## Review decision

The forward Migration is a **conditional GO for isolated Staging only** and a
**NO-GO for Production until the live read-only inventory, backup evidence, and
operator approvals in this runbook are complete**. Static review covered all 46
`pgTable` definitions in `lib/db/schema.ts` plus the nine immutable managed
Migration entries. None of the proposed table, function, or index names collide
with those repository definitions. This does not prove that an untracked object
does not exist in Production, so
[`phase3a-message-replica-preflight.sql`](sql/phase3a-message-replica-preflight.sql)
must be run with a dedicated read-only connection before approval.

The active Migration manifest is intentionally unchanged. The transactional
core and the two indexes on existing tables are kept separate because PostgreSQL
does not allow `CREATE INDEX CONCURRENTLY` inside a transaction:

- [`phase3a-message-replica-proposal.sql`](sql/phase3a-message-replica-proposal.sql):
  transactional core
- [`phase3a-message-replica-concurrent-indexes.sql`](sql/phase3a-message-replica-concurrent-indexes.sql):
  two concurrent indexes, outside a transaction
- [`phase3a-message-replica-rollback.sql`](sql/phase3a-message-replica-rollback.sql):
  destructive Level 4 proposal; never automatic

Before a Production rollout, either teach the managed runner to execute a
reviewed non-transactional Migration step or use a separately approved manual
index procedure. Registering the proposal in the manifest is a later approval
point, not part of this phase.

## Forward Migration safety classification

| Operation | Classification | Reason and control |
| --- | --- | --- |
| Create three new replica tables | SAFE | New names; no existing data rewrite |
| Checks, PK, unique constraint, Tombstone FK | SAFE | Only new tables are constrained |
| Indexes on new replica tables | SAFE | New/empty objects during Migration |
| Add nullable provenance columns to `discord_message` | CAUTION | Brief `ACCESS EXCLUSIVE`; metadata-only on supported PostgreSQL, but waits behind long transactions |
| Add nullable provenance column to `recent_activity` | CAUTION | Same brief lock risk |
| Concurrent partial unique index on `discord_message` | CAUTION | Allows normal writes but scans the existing table and consumes I/O |
| Concurrent partial unique index on `recent_activity` | CAUTION | Allows normal writes but scans the existing table and consumes I/O |
| Create/replace materialization function | SAFE | DDL only; it performs no materialization until called |
| Execute materialization during Canary | CAUTION | Transactionally updates existing Dashboard read models |
| Existing column type change | Not present | Would be HIGH RISK |
| Existing-row UPDATE/backfill in Migration | Not present | Would be HIGH RISK |
| DROP/TRUNCATE in forward Migration | Not present | Would be HIGH RISK |

There is no HIGH RISK operation in the forward SQL after splitting concurrent
indexes. The Level 4 rollback contains destructive DROP operations and is HIGH
RISK. If the live inventory finds a name/type mismatch, invalid pre-existing
index, partial schema, or unexpected constraint, the Production proposal stops.

## Lock and downtime review

- Nullable `ADD COLUMN` takes `ACCESS EXCLUSIVE` briefly. Use a 5-second
  `lock_timeout`; a timeout is safer than waiting behind a busy API transaction.
- Indexes on the two existing tables use `CREATE INDEX CONCURRENTLY`. They do
  not block ordinary inserts/updates/deletes, but they take longer, perform two
  scans, add I/O, and cannot run inside `BEGIN`.
- A failed concurrent build can leave an invalid index. `IF NOT EXISTS` must not
  be used to declare success without checking `pg_index.indisvalid` and
  `indisready`; the preflight CLI checks both.
- Each concurrent index statement must be sent as a separate database command.
  Sending the complete multi-statement file as one Node `pg` query creates an
  implicit transaction context and PostgreSQL rejects it with `25001`.
- The core transaction must run with Message Local-First OFF. No Sync Worker may
  call the new function until both concurrent indexes are valid.
- The function independently verifies both existing-table indexes on every call
  and returns SQLSTATE `55000` before writing when either is missing/invalid.
- Do not run while long transactions, retention cleanup, backup dump pressure,
  or elevated Bot/API latency are present.
- Table size and lock inventory must be captured immediately before execution.
  No fixed duration estimate is safe without the live table sizes.

## Guild Canary routing

Routing is exclusive and deterministic:

```text
LOCAL_MESSAGE_STORAGE_ENABLED=false
    -> every Guild uses LEGACY

LOCAL_MESSAGE_STORAGE_ENABLED=true
LOCAL_MESSAGE_CANARY_GUILDS=<empty>
    -> every Guild still uses LEGACY

LOCAL_MESSAGE_STORAGE_ENABLED=true
LOCAL_MESSAGE_CANARY_GUILDS=1216303889599565875,1507737783404462130
    -> listed Guilds use LOCAL_FIRST; every other Guild uses LEGACY
```

The list accepts 1-100 unique 17-20 digit Discord IDs. Invalid IDs stop startup.
There is no wildcard and no Shadow Write. A Message event is dispatched to
exactly one repository. The interpreted list and per-Guild route are stored in
local `sync_metadata`; the environment remains the source of truth after restart.

Removing a Guild from the list, or turning the global flag OFF, is rejected when
that removed Guild still has Pending/Retry/Processing Message Outbox rows. The
force override remains human-only and requires a reconciliation plan.

## Preflight and status tools

Use a dedicated read-only PostgreSQL role and URL. The tools never fall back to
`DATABASE_URL`:

```powershell
corepack pnpm message:canary:preflight
corepack pnpm message:canary:check
corepack pnpm message:canary:compare
```

`MESSAGE_CANARY_READONLY_DATABASE_URL` must have SELECT/catalog access only.
The status command opens SQLite read-only. Preflight opens the configured local
SQLite and performs a temporary Outbox insert inside a transaction that is
deliberately rolled back, proving writeability without leaving a row.

Preflight checks:

- SQLite open/write state, quick integrity, WAL mode, size, WAL size, free disk
- transactional Outbox write/rollback
- Sync Worker snapshot and readiness
- Pending/Retry/Processing, oldest pending, Dead Letter
- Circuit state/open duration
- all replica tables, materialization function, provenance columns
- all six required indexes are present, ready, and valid
- proposal schema version label
- configured Canary Guild IDs and routing mode

Result mapping is `PASS = HEALTHY`, `WARN = DEGRADED`, `FAIL = ABORT`. A FAIL is
a hard refusal signal; neither CLI changes an environment flag or database schema.

## Monitoring and health policy

The JSON snapshot includes:

- local writes/failures and last local write
- Pending count, oldest pending, last local/synced Message
- sync successes/failures, last sync, sync lag
- Dead Letter count
- Circuit state and cumulative open count
- SQLite/database/WAL/free-disk sizes
- replica batch query count
- route-derived Canary legacy query count (must remain zero)
- schema readiness and optional comparison differences

Default policy:

| State | Conditions |
| --- | --- |
| HEALTHY | Integrity/WAL/schema/worker healthy; Circuit closed; no new failures/DLQ/differences; queue below warnings |
| DEGRADED | Global flag intentionally still OFF, short Circuit OPEN/HALF_OPEN, new sync failure, Pending >= 500, lag/oldest >= 120s, WAL >= 256 MiB, or free disk <= 2 GiB |
| ABORT | Local write failure, integrity/WAL failure, worker/schema unavailable, new Dead Letter, comparison mismatch, Pending >= 5,000, lag/oldest >= 600s, Circuit OPEN >= 300s, WAL >= 512 MiB, or free disk <= 512 MiB |

All thresholds are environment-configurable. The baseline recorded when the
Canary Guild set changes prevents historical counters from being mistaken for a
new Canary failure.

An ABORT result does not drop schema. Automatic database rollback is prohibited.

## Read-only comparison

`message:canary:compare` reports differences only; it never logs Message bodies.
For each Canary Guild it checks:

- local Event count against non-active-member replica Event count
- local current Message count against materialized winner count
- local deleted count against Tombstone count
- Recent Activity count linked by `sourceEventId`
- expected distinct active members and missing materializations
- `legacy baseline + unique Create events` against Daily Stats
- latest Create timestamp

The report also computes `legacyEquivalentQueryCount` using the reviewed legacy
path: Create 4 writes, Update 1, Delete 2. Query reduction is:

```text
(legacyEquivalentQueryCount - replicaBatchQueryCount)
----------------------------------------------------- x 100
              legacyEquivalentQueryCount
```

`replicaBatchQueryCount` is a client/network call count. Statements executed
inside the PostgreSQL function are not extra network round trips.

## Staging Canary procedure

Use only a Test Discord Guild, isolated SQLite path, and isolated PostgreSQL or
Neon test branch. Do not create a paid resource automatically.

1. Save the commit, flags, local DB path, and test DB identifier.
2. Apply the transactional core to the isolated DB.
3. Apply concurrent indexes separately and verify all are valid.
4. Start the Sync Worker with the isolated URL; keep Bot routing Legacy.
5. Run preflight and require PASS (the intentional global-OFF warning may be
   acknowledged before arming).
6. Set one Test Guild in `LOCAL_MESSAGE_CANARY_GUILDS`, arm the global flag, and
   restart only the isolated Bot.
7. Verify Create, Update, Delete, Bulk Delete, and non-Canary Legacy routing.
8. Stop the Sync Worker; confirm local writes continue and queue grows within the
   threshold. Restart it and require complete drain.
9. Stop PostgreSQL; confirm Circuit OPEN and Bot continuity. Restore it and
   require HALF_OPEN then CLOSED.
10. Run comparison and require no differences or Dead Letter.
11. Drain the queue, remove the Test Guild from the list, restart, and confirm
    Legacy routing. Do not drop schema.

## Production Migration procedure — not executed

1. Obtain approvals and a verified backup/restore point.
2. Record schema dump, read-only inventory, `schema_migration`, current flags,
   commit, Bot version, and Sync Worker version.
3. Require healthy Bot/API/Neon and no long-running conflicting transaction.
4. Keep all local storage, worker, and Message routing flags OFF.
5. Apply the transactional core with a short lock timeout.
6. Apply each concurrent index outside a transaction.
7. Verify tables, FK/unique/checks, columns, function, and valid/ready indexes.
8. Keep Message Local-First OFF. Do not start a Canary in the Migration window.
9. Configure/start the Worker and local storage only in a separately approved
   rollout window.
10. Run preflight, select one explicitly approved Canary Guild, then start Stage 1.

Backup evidence must include schema, Migration journal/version, the four existing
materialization tables, new replica tables after creation, flags, current commit,
Bot version, Worker version, backup timestamp/hash, and a documented restore test.
This phase does not acquire that Production backup.

## Rollback levels

1. **Stop expansion:** do not add Guilds; keep current Canary stable while
   investigating.
2. **Stop ingestion safely:** stop the Bot or remove a Guild only after its
   Message Outbox is drained. The Worker may keep draining.
3. **Return routing to Legacy:** require Pending/Retry/Processing = 0 and a clean
   comparison, then remove the Guild/global flag and restart. With unresolved
   pending data, the guard blocks this. The force flag is a manual emergency
   action that creates a reconciliation obligation.
4. **Schema rollback:** human approval only, after archiving replica Events and
   Tombstones. Dropping these loses forensic/idempotency history. Additive
   provenance columns and materialized Dashboard rows are retained by default;
   removing them requires a separate maintenance window and stronger locks.

After Canary writes begin, immediately dropping replica tables is not a valid
operational rollback. Pending SQLite events, Tombstones, and Legacy baseline data
must be reconciled first.

## State-gated rollout plan

| Stage | Scope | Advance conditions | Stop conditions |
| --- | --- | --- | --- |
| 0 | Migration only; routing OFF | Schema/index preflight PASS, backup evidence, Worker readiness | Any partial/invalid object, lock timeout, latency anomaly |
| 1 | One low-risk Guild | Error/DLQ/difference 0; Circuit closed; queue and lag below warning; Create/Update/Delete observed | Any ABORT condition |
| 2 | Two to three Guilds | Stage 1 remains healthy and each new Guild independently matches | Any Guild mismatch or shared queue deterioration |
| 3 | Small representative set | Stable per-Guild comparisons, disk/WAL headroom, query reduction demonstrated | Error, DLQ, sustained DEGRADED, quota regression |
| 4 | Candidate full set | Explicit approval, capacity evidence, restore rehearsal, every prior state gate healthy | No automatic promotion; any regression stops expansion |

Elapsed time alone never advances a stage. Each stage requires fresh events,
zero new local errors, zero Dead Letter, stable/draining queue, acceptable lag,
closed Circuit, no comparison differences, and measured query reduction.

## Remaining risks and approval points

- Live Production object collision and table-size checks remain unperformed.
- The active managed Migration runner does not yet own the split concurrent step.
- Local timings from the isolated PostgreSQL test are not Production capacity data.
- Legacy-equivalent query count is model-based; Neon/Vercel provider telemetry
  remains the authoritative quota measurement.
- Comparison validates aggregates and IDs, not Message body equality by design.
- Automatic routing abort is not enabled; the CLI emits ABORT for the operator or
  an approved supervisor. It never mutates Production flags.
- Stage 1 needs a real Staging rehearsal and explicit Production authorization.

Phase 3B Reaction Local-First has not started.
