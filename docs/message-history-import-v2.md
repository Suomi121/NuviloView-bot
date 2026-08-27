# Message History Import SQLite-First v3

Message History Import v3 is a Guild-scoped Discord message backfill whose raw
source of truth is the Bot host's SQLite database. The dashboard keeps only the
bounded control metadata needed to request and observe work. A Web request never
performs the long-running import and History Import never inserts raw messages
into Cloud `discord_message`.

The feature is staged off by default:

```env
MESSAGE_HISTORY_IMPORT_V2_ENABLED=false
MESSAGE_HISTORY_IMPORT_SQLITE_FIRST_ENABLED=false
MESSAGE_HISTORY_IMPORT_SQLITE_FIRST_GUILD_IDS=
MESSAGE_HISTORY_IMPORT_STALL_SECONDS=120
MESSAGE_HISTORY_IMPORT_MAX_RETRIES=5
MESSAGE_HISTORY_IMPORT_MAX_PAGES_PER_CHANNEL=50000
```

Despite the retained compatibility flag name, newly created Jobs use schema
version 3. Enabling it requires writable local storage, Message Local-First, and
Analytics Compaction for every Guild listed in
`MESSAGE_HISTORY_IMPORT_SQLITE_FIRST_GUILD_IDS`. Startup and Termux preflight
reject an unsafe combination.

## Data flow and transaction boundary

For every Discord page (up to 100 messages), one SQLite transaction performs:

1. stable message-create insert or duplicate classification;
2. provenance and live-priority enforcement;
3. local projection dirty tracking;
4. channel checkpoint and counters update;
5. Job counters update;
6. stable batch receipt insert.

The receipt key combines Job, channel progress, and the requested `before`
Snowflake. Replaying a page after a crash returns the existing receipt, so the
checkpoint can be repaired without increasing counts twice.

Raw content remains in `message_event_log` / `message_events`. Cloud replicas
receive only deterministic Current, Guild Daily, Channel Daily, and User Daily
Analytics snapshots when their semantic checksum changes. Projection payloads
do not contain message content.

## Control plane

PostgreSQL `history_import_job`, `history_import_channel_progress`, and
count-only audit rows remain the minimal Web control plane for Start, Pause,
Resume, Cancel, Retry, Skip, Reset, and history-deletion requests. SQLite keeps
the authoritative local Job state, per-channel checkpoint, retry state,
heartbeat, batch receipts, and raw rows.

A Cloud metadata write that fails after the SQLite commit is logged as deferred;
it does not discard or re-send raw data to Cloud. A resumed Job may fetch a page
again, but the stable local receipt makes that replay idempotent.

## Provenance and duplicate rules

The local source rank is:

- `history_import` (0)
- `existing` (1)
- `live` (2)

Discord message ID is the stable identity. An imported message already present
as `existing` or `live` is counted as a duplicate and does not overwrite it. A
later live create for an imported row promotes its event/current row to `live`,
clears the import Job ID, and does not increment Analytics counts again.

Fetched, eligible, inserted, and duplicate counters remain distinct. Analytics
counts only newly inserted create events.

## State, retry, and restart

Job states remain `queued`, `preparing`, `running`, `pausing`, `paused`,
`cancelling`, `cancelled`, `completed`, `failed`, and `stalled`.

- Pause and Cancel are honored only at batch boundaries.
- Resume preserves the SQLite checkpoint and resets the Cloud channel for safe
  replay.
- Retry targets only a failed channel.
- Discord/network failures use bounded retry and do not create Cloud raw writes.
- SQLite Job, checkpoint, duplicate counters, dirty state, and receipts survive
  graceful close and reopen.

## Imported-history deletion

The API requires signed-in Guild authorization, trusted origin, rate limiting,
no active Job, and the exact phrase `RESET IMPORTED DATA`. It queues a control
request; the Bot executes an atomic local deletion where both conditions match:

```text
guild_id = requested Guild
source = history_import
```

`live` and `existing` rows are not selected. A previously promoted live row is
therefore preserved. Derived local message state is rebuilt, affected Analytics
buckets are marked dirty, and only compacted summaries are updated in Cloud.
The deletion request ID is stored locally so replay is idempotent.

## Privacy and logging

Message content is not stored in Job, checkpoint, batch receipt, audit,
diagnostic, or application logs. These contain IDs, counters, timestamps,
lifecycle state, host identity, and safe error codes only. Tokens, database
URLs, authorization headers, and raw Discord responses must not be logged.

## Rollout and rollback

1. Deploy code with both History flags false.
2. Confirm local migration 6, SQLite WAL/quick-check, Message Local-First, and
   Analytics Compaction for one Canary Guild.
3. Add only that Guild to the SQLite-first Guild list, then enable the two
   History flags on the Bot/Web control plane.
4. Rehearse small import, Pause/Resume, restart, duplicate handling, projection
   checksums, and history-only deletion.
5. Expand the Guild list only after Pending/Retry/DLQ return to zero.

Rollback sets `MESSAGE_HISTORY_IMPORT_V2_ENABLED=false` and
`MESSAGE_HISTORY_IMPORT_SQLITE_FIRST_ENABLED=false`. Existing SQLite rows and
the additive local schema stay intact. Do not enable the removed PostgreSQL raw
write path and do not dual-write.
