# Message History Import v2

Message History Import v2 is a durable, Guild-scoped Discord message backfill. The dashboard creates and controls a database Job; the persistent Discord Bot fetches one channel at a time and commits each Discord page together with its checkpoint. A Web request never performs the long-running import.

The feature is staged off by default:

```env
MESSAGE_HISTORY_IMPORT_V2_ENABLED=false
MESSAGE_HISTORY_IMPORT_STALL_SECONDS=120
MESSAGE_HISTORY_IMPORT_MAX_RETRIES=5
MESSAGE_HISTORY_IMPORT_MAX_PAGES_PER_CHANNEL=50000
```

The same `MESSAGE_HISTORY_IMPORT_V2_ENABLED` value must be used by the Web and Bot only after the additive migration is applied. The v2 Worker processes only `version = 2` Jobs. While the flag is off, the existing importer remains compatible with the old schema.

## State and control contract

Job states are `queued`, `preparing`, `running`, `pausing`, `paused`, `cancelling`, `cancelled`, `completed`, `failed`, and `stalled`. A partial unique index permits only one active Job per Guild.

- Pause and Cancel set durable request flags. The Worker acts only before or after a fetch/save batch; it never kills the Bot process.
- Resume changes a paused or stalled Job back to queued and preserves the last committed `before` message checkpoint.
- Retry changes only a failed channel back to pending.
- Skip changes only the selected channel. A running channel is skipped at the next batch boundary.
- Restart recovery changes a Job with a stale progress/heartbeat timestamp to `stalled`; it does not delete or silently restart it.

Each page uses Discord's maximum 100-message fetch. Fetching is sequential and relies on discord.js for Discord rate limits. Retryable Discord/network/database errors use bounded delays of 1, 5, 15, 30, and 60 seconds. Permission failures are not retried indefinitely. Pagination has a configurable hard page ceiling.

## Data and privacy

`discord_message.id` remains the stable Discord Snowflake primary key. History inserts use `ON CONFLICT DO NOTHING`; duplicate messages are counted rather than rewritten. A later live Gateway event for the same message changes its provenance to `live`, ensuring live data cannot be selected by history-data deletion.

Provenance values are:

- `existing`: rows created before provenance could be known safely;
- `live`: realtime Gateway collection;
- `history_import`: v2 history import.

Message content was already stored by NuviloView for message search. v2 does not add content to Job, checkpoint, audit, diagnostic, or application logs. Those records contain only IDs, counters, timestamps, lifecycle events, host identity, and safe error codes. Tokens, database URLs, authorization headers, raw Discord responses, and message content are excluded.

Health Score formulas are unchanged. When the feature flag is enabled, Analytics exposes live/existing/history-import message counts and the imported share as Data Quality evidence so later calibration can decide how to treat historical activity.

## Reset safety

`Reset import state` clears the selected Job's checkpoints, counters, flags, and safe errors. It does not delete `discord_message` or any other Analytics table. A running/preparing/pausing/cancelling Job must be cancelled first.

`Delete imported history data` is a separate Danger Zone action. It requires:

1. signed-in server-side Guild management authorization;
2. trusted Origin, bounded JSON body, and rate limiting;
3. no active Job for that Guild;
4. the exact phrase `RESET IMPORTED DATA`;
5. `guildId = requested Guild` and `source = 'history_import'` in the deletion predicate.

Rows marked `live` or `existing`, Job history, and other Guilds are not selected. The UI previews the affected row count before confirmation.

## Authorization and diagnostics

GET, Start, Pause, Resume, Cancel, Reset, Retry, Skip, and Delete all repeat authentication and Guild authorization in the API. Job and channel SQL predicates bind both the Job ID and Guild ID, preventing cross-Guild reuse.

The dashboard reports actual channels completed/total, fetched, inserted, duplicate and failed counts, current channel, messages per second, Worker heartbeat, last Discord response, last database write, and last progress. It does not invent a message total or ETA.

## Retention

Terminal Jobs (`cancelled`, `completed`, `failed`) and their cascading channel checkpoints are eligible for bounded cleanup after 90 days. Count-only import audit events are also eligible after 90 days. Active, paused, and stalled Jobs are excluded. Cleanup remains dry-run by default and is never invoked by application startup.

## Rollout and rollback

1. Keep the flag false on every host.
2. Validate and apply `20260821-message-history-import-v2.sql` in a separately approved maintenance step.
3. Confirm migration journal/drift and take a verified backup.
4. Deploy the compatible Web and Bot code with the flag still false.
5. Enable v2 for a developer/test Guild environment, then one Guild, then several Guilds.
6. Verify Start, checkpoint, Pause, Resume, Cancel, stalled recovery, history-only deletion, and live-data protection against real Discord data before general availability.

Application rollback starts by setting the flag false on both Web and Bot and restoring the previous application build. The additive columns, tables, and indexes can remain in place. Do not roll back by dropping tables or deleting migration journal records.

## Current release condition

Local tests, type checking, lint, build, migration validation, and secret scanning can verify the implementation contract. A real Discord API import and an isolated migrated PostgreSQL integration rehearsal are still required before this feature can be marked generally ready.
