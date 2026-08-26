# Message Local-First Phase 3A Staging Canary

Date: 2026-08-24

Readiness checkpoint: `84da14f8c21f4f17c3615e04d09d2957f34b2c7b`

Branch: `feat/local-first-message-phase3a`

## Result

**Production Canary: NO-GO**

The isolated SQLite, Sync Worker, PostgreSQL, routing, failure recovery, and
comparison checks passed. A real Discord Canary was not run because no separate
Staging/Test Bot token or Test Guild ID was configured. The Production Bot token
and Production database credentials were deliberately not reused.

## Environment

- Discord: no login; Discord-shaped Message events were injected through the
  production Message Domain Router.
- Canary Guild: synthetic ID `1216...5875`.
- Non-Canary Guild: synthetic ID `1216...5876`.
- SQLite: dedicated `data/staging-canary-20260824/staging-canary.sqlite`.
- PostgreSQL: Docker `postgres:17-alpine`, PostgreSQL 17.11, bound only to
  `127.0.0.1:57048`.
- Sync Worker: the production `SyncWorker` and PostgreSQL replica adapter, fixed
  batch size 25 for the 100-event measurement.
- Production DB, Production Bot, Vercel, and Production feature flags: untouched.

The SQLite database and Worker snapshots contain test-only data and are removed
after the final validation. This document is the retained evidence.

## Readiness and routing

- Initial Preflight: `PASS / HEALTHY`.
- SQLite accessible, `quick_check=ok`, WAL enabled, Outbox rollback probe passed.
- Sync Worker `RUNNING`, Circuit `CLOSED`, Queue 0, Dead Letter 0.
- All three replica tables, six indexes, and the batch function were ready.
- Canary routing: `LOCAL_FIRST`.
- Non-Canary routing: `LEGACY`.
- Non-Canary event called the Legacy adapter once and produced no Local write.
- Global OFF with Queue 0 routed every Guild to `LEGACY`.
- Global OFF with three unsynced events was rejected with
  `LOCAL_MESSAGE_ROLLBACK_PENDING`.
- Reopening SQLite and recreating the router preserved the intended routing,
  WAL mode, and integrity state.

## Message and aggregate checks

Synthetic Discord-shaped events covered normal Japanese text, ASCII, emoji,
mention-like content, reply metadata, attachment metadata, and two channels.
Message content was not printed by the Canary CLI or comparison output.

- 100 Create events: Local writes 100, Local write failures 0.
- Edit sequence: Create -> Edit 1 -> Edit 2 -> Edit 3.
- Delete and late old Edit: Tombstone remained the winner; no revival.
- Bulk Delete: two Tombstones committed without a partial local result.
- Final isolated comparison: 118 Local events = 118 Replica events.
- Current Messages: 108.
- Tombstones: 3.
- Recent Activity: 111.
- Active Members: 5, missing 0.
- Daily Stats mismatches: 0.
- Comparison differences: 0.

Reply and attachment objects were accepted by the Message handler shape, but
Phase 3A does not persist reply or attachment metadata as dedicated fields. This
is a known coverage limitation, not a staging failure in the existing contract.

## Worker, database, and crash recovery

### Worker stopped

With the Worker stopped, 100 events were written locally. Pending increased to
100 while SQLite integrity stayed healthy and the Message path remained usable.

### Worker restarted

The Queue drained from 100 to 0 using four PostgreSQL batch queries of 25 events.
Duplicate, failed, and Dead Letter counts remained zero.

### PostgreSQL unavailable

The exact isolated Docker container was paused. Three more events were stored in
SQLite with zero Local write failures. The Worker Circuit entered `OPEN`, the
Queue retained the events, and Dead Letter remained zero. After unpausing the
container, the Circuit returned to `CLOSED` and all three events synchronized.

The Staging thresholds were intentionally aggressive (`1s` Circuit open period,
`1s` query timeout), producing repeated probes. Production defaults remain
unchanged and use a 60-second Circuit open period.

### Forced Worker termination

A uniquely marked Staging Worker was force-stopped while an isolated PostgreSQL
request was blocked. Outbox rows remained in `processing`/`retry`. A replacement
Worker released the expired lock, synchronized all five events, and left Queue 0,
processing 0, Dead Letter 0, and Circuit `CLOSED`.

## Query and performance results

| Workload | Legacy-equivalent queries | Replica queries | Reduction | Batch elapsed | Duplicate replay |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 Create | 400 | 4 | 99.00% | 25.74 ms | 22.45 ms |
| 1,000 Create | 4,000 | 10 | 99.75% | 176.66 ms | 182.93 ms |

The indexed-read plan used the intended index. These are local Staging reference
values and are not a Production performance guarantee.

For the 100-event Worker-stop run, Local write latency was:

- average: 0.545 ms
- p95: 1.602 ms
- maximum: 3.898 ms
- SQLite database after enqueue: 598,016 bytes
- WAL peak observed after enqueue: 4,194,192 bytes

After all recovery tests and checkpointing, SQLite was 671,744 bytes and WAL was
0 bytes.

## Health and Dead Letter

- Healthy path: `HEALTHY`, no warnings, no abort reasons.
- Worker stopped: Preflight returned `FAIL / ABORT` with
  `sync_worker_unavailable`.
- Circuit `OPEN`, pending thresholds, sync lag thresholds, and Dead Letter abort
  behavior are covered by deterministic Canary tests.
- An intentionally invalid synthetic payload entered Dead Letter in the isolated
  PostgreSQL integration test. Payload retention and explicit requeue are covered
  by the Sync Worker tests.
- No normal Message entered Dead Letter.

## Previously skipped test

Test: `Phase 3A Message replica migration and Batch Sync pass on isolated PostgreSQL`.

It is intentionally skipped when `TEST_REPLICA_DATABASE_URL` is absent so the
normal test suite never contacts a database. It does not depend on Production and
is safe in Staging. With the loopback-only PostgreSQL URL supplied, all 16 tests
passed with zero skips.

## Validation and cleanup

Final validation results:

- Full suite: 281 tests, 280 pass, 0 fail, 1 intentional skip without a Test DB URL.
- Isolated PostgreSQL suite: 16/16 pass, 0 skip.
- Build and TypeScript: pass.
- JavaScript syntax: 103 modules pass.
- Lint: 0 errors and 12 pre-existing warnings.
- Secret scan: pass.
- Production dependency audit: no known vulnerabilities.
- Migration integrity: 9/9 checksums pass.
- Static schema drift: 46 tables and 43 indexes, pass.
- `git diff --check`: pass.

Cleanup requirements:

- no Staging/Test Bot was started;
- all Staging Sync Worker processes stopped;
- the isolated PostgreSQL container stopped and removed;
- the dedicated SQLite directory was removed after its final size/integrity
  check (`quick_check=ok`, Queue 0, processing 0, Dead Letter 0); six test files
  totaling 708,876 bytes were removed;
- no Staging secret file created;
- Production connections and changes remained zero.

## Gate to the next phase

Do not run a Production Migration or Production Canary yet. The remaining gate is
one real Test Discord Guild run using a separate Staging/Test Bot token. It must
repeat Create, Edit, Delete, Bulk Delete, Bot restart, and final comparison with
zero differences before this result can become a GO candidate.
