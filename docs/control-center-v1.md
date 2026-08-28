# NuviloView Control Center v1

Control Center is a read-only PowerShell dashboard for the local NuviloView
checkout. It renders the lightweight status snapshots that the Bot and Sync
Worker already write. It does not query Supabase, Turso, Neon, or SQLite and it
does not start, stop, repair, or configure any runtime process.

## Commands

Run these commands from the repository root:

```powershell
.\nuviloctl.ps1 status
.\nuviloctl.ps1 status --once
.\nuviloctl.ps1 status --watch
.\nuviloctl.ps1 status --watch --interval 5
.\nuviloctl.ps1 status --json
.\nuviloctl.ps1 help
.\nuviloctl.ps1 version
```

`status` and `status --once` render one dashboard. `--watch` refreshes every
five seconds by default; its allowed range is 1–300 seconds. The display is
composed once per refresh and replaces the previous frame to reduce flicker.
`--json` emits the stable schema v1 status object without ANSI color codes.

Use `--project-root <path>` to inspect another local checkout or a directory
containing copied status snapshots. This option still performs local reads
only; v1 does not open SSH connections to a remote Termux host.

## Data sources

Control Center reads at most 2 MiB from each status file:

- `data/runtime/sync-worker-health.json`, or `SYNC_METRICS_PATH`
- `data/runtime/neon-runtime-health.json`, or
  `NUVILOVIEW_RUNTIME_STATUS_PATH`
- `Android/runtime/storage-health.json` as a SQLite fallback
- the local SQLite/SQLite WAL file sizes when the configured file exists
- the local drive capacity and the existing Windows runner PID file

Only a small allowlist of non-secret settings is read from `.env.local` or
`.env`. Environment contents, credentials, URLs, tokens, errors containing
provider payloads, and message content are never displayed.

Snapshots older than 120 seconds are marked stale by default. Set
`NUVILOCTL_STALE_AFTER_SECONDS` to adjust that local display threshold.

## State model

Overall state is one of `HEALTHY`, `DEGRADED`, `CRITICAL`, or `OFFLINE`.

- `CRITICAL`: SQLite reports an unhealthy state or required-provider DLQ is
  non-zero.
- `OFFLINE`: both Bot and Worker evidence are absent/offline.
- `DEGRADED`: a required provider/circuit is unhealthy, a snapshot is stale or
  missing, Discord is disconnected, or pending/retry work exists.
- `HEALTHY`: local runtime evidence is fresh, SQLite is healthy, required
  providers are healthy with closed circuits, and the queue is clear.

An optional, disabled Neon replica is shown as `OPTIONAL` and does not by
itself degrade provider completeness. The separate Bot runtime snapshot may
still report `DEGRADED` when legacy Neon-backed features are unavailable.

The global queue values use the maximum count across required provider
deliveries. This avoids double-counting the same outbox event once for
Supabase and once for Turso. “Last complete sync” uses the oldest latest-success
timestamp among required providers, which represents the latest point reached
by every required replica.

## Usage bars and metric limits

SQLite storage, free disk, and queue occupancy use pink/magenta/red HP-style
bars. The default local display budgets are:

- SQLite soft budget: 1 GiB (`NUVILOCTL_SQLITE_BUDGET_BYTES`)
- Queue display capacity: 10,000 (`NUVILOCTL_QUEUE_CAPACITY`)

These are Control Center warning/display budgets, not provider-enforced quotas.
Provider daily read/write counts are shown as `N/A` because the current status
snapshot does not expose trustworthy calendar-day counters. The dashboard
shows available lifetime totals separately and never labels them as daily
usage. Optional future daily write budgets can be configured with
`NUVILOCTL_SUPABASE_DAILY_WRITE_BUDGET` and
`NUVILOCTL_TURSO_DAILY_WRITE_BUDGET` once matching daily counters are added to
the snapshot.

Analytics Compaction counters currently reset with the Worker process, so the
dashboard labels them as “worker session” rather than “today”.

## Safety and limitations

- No cloud API or database polling is performed.
- Missing or malformed files produce warnings instead of terminating status.
- The dashboard does not mutate queue, PID, lock, JSON, SQLite, or env files.
- A Windows dashboard cannot see live Termux-only files unless those snapshots
  are made available in a local inspection directory.
- v1 intentionally does not implement start, stop, restart, deploy, update,
  repair, or queue mutation commands.
