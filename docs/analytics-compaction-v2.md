# Analytics Compaction v2

Analytics Compaction v2 keeps Discord Message, Reaction, Voice, and Member Raw
Events in the local SQLite database. Cloud replicas receive deterministic
analytical projections through the existing snapshot delivery pipeline instead
of receiving one Raw Event row per Discord action. With
`LOCAL_FIRST_ALL_GUILDS_ENABLED=true`, all normal Production Guilds use this
path; the older Guild lists remain emergency rollback metadata.

```text
Discord Raw Event -> SQLite -> dirty daily/current bucket
  -> bounded Sync Worker compaction -> semantic checksum
  -> changed snapshot only -> Supabase + Turso -> Web Read Router
```

## Cloud write inventory

| Path | Class | v2 handling |
| --- | --- | --- |
| Message Local-First create/update/delete | Raw event | SQLite only for enabled Canary Guilds |
| Message active-member observation | Raw/derived event | SQLite only for enabled Canary Guilds |
| Reaction analytics event | Raw event | SQLite-only for Event Local-First Guilds; projected as counts, unique reactors, reacted messages, and bounded top reactions |
| Voice session event | Raw event/state | SQLite-only for Event Local-First Guilds; projected as seconds/minutes, sessions, unique members, concurrency, and bounded channel totals |
| Member lifecycle event | Raw event/state | SQLite-only for Event Local-First Guilds; projected as joins, leaves, delta, and the observed current count |
| `local_message_daily_stats` and active-member rows | Local summary | Source for projections; not copied directly |
| `analytics_snapshot` | Snapshot | Provider UPSERT only when the semantic checksum changes |
| Guild/runtime/sync status snapshots | Snapshot/control | Existing bounded snapshot path retained |
| Discord OAuth, Web sessions, user settings | Control/Auth | Unchanged; Supabase Web Auth remains separate |
| Message History Import v3 job/control tables | Control | Minimal PostgreSQL control path retained for Web actions |
| Message History Import v3 raw messages/checkpoints | Local raw/control | SQLite transaction; never sent as Cloud raw rows |

The Cloud `analytics_snapshot` table is reused as the provider-neutral
projection table. Its `aggregate_id` identifies one of these bounded buckets:

- `v2:guild:{guildId}:current`
- `v2:guild:{guildId}:daily:{YYYY-MM-DD}`
- `v2:guild:{guildId}:channel:{channelId}:daily:{YYYY-MM-DD}`
- `v2:guild:{guildId}:user:{userId}:daily:{YYYY-MM-DD}`

Projection payload schema v3 extends the original Message projection with
Reaction, Voice, and Member summaries. Each payload contains bounded counts,
identifiers, and timestamps only. Raw message content and raw Discord events
are never included. Supabase and Turso receive the same semantic checksum and
version; Neon remains optional compatibility storage.

The hardened versioned contract uses additive schema 4 fields while preserving
the same keys and schema-3 read compatibility. It adds `projectionVersion: 2`,
bucket boundaries, source checkpoint metadata, fixed-boundary scheduling, and
Message create/edit/delete/reply activity. Runtime/generation/source cursor
timestamps are excluded from the semantic checksum, so equal analytics still
produce zero Provider writes.

## Scheduling and Web refresh

The default projection interval is 900 seconds. Dirty buckets are aggregated at
most once per interval, while a previously unseen bucket may be built
immediately. The next eligible time is the fixed `:00/:15/:30/:45` boundary,
not `request time + 15 minutes`. The Web countdown updates text in the browser once per second and
performs no request itself. Each Analytics surface performs one initial read,
then exactly one read when the countdown reaches zero. Returning to a visible
tab reads only when the previous deadline has elapsed. Deadline and visibility
events share an in-flight/deadline guard, so they cannot duplicate the same
refresh. Runtime/provider health remains on its independent 60-second cadence;
there is no one-second or one-minute Analytics polling loop.

## Send-reduction metrics

SQLite tracks `raw_events_seen`, `snapshots_built`, `snapshots_changed`,
`snapshots_skipped_checksum` (with the previous `snapshotsSkipped` compatibility
alias), total Provider writes, per-Provider writes, and the derived
write-reduction ratio. Browser memory separately tracks `analytics_fetches`,
`countdown_refetches`, and `visibility_refetches`. These counters are
operational telemetry and contain no message content.

## Message History Import SQLite-first integration

`lib/message-history-import-worker.mjs` sends each Discord page to the local
History repository. One SQLite transaction records the raw rows, provenance,
duplicate count, channel checkpoint, and Job counters. Newly inserted rows mark
the same bounded projection buckets dirty; no `discord_message` raw INSERT is
performed by History Import.

The Web-facing PostgreSQL tables remain a small control plane because Vercel
cannot open the Bot host's SQLite file. Cloud metadata failure never rolls back
a completed local batch: its stable batch receipt lets a replay repair the
control-plane checkpoint without duplicating the message or count. Imported
data deletion is queued through the control plane and executed locally with a
Guild-plus-`history_import` predicate. Rows promoted to `live` are preserved.

## Compaction unit and incremental checkpoint

Cloud storage keeps only current Guild, daily Guild, daily Channel, and daily
User buckets. The Worker executes every 15 minutes; separate 15-minute and
hourly Cloud rows are intentionally omitted because current weekly/monthly
Dashboard views compose from daily rows. Each Raw Event marks only affected
buckets. `source_sequence`, `last_aggregated_sequence`, and `last_event_at`
survive restart. Late or History Import events re-dirty their original UTC day
instead of triggering a full Projection rebuild.

Each pass is bounded by `ANALYTICS_PROJECTION_BATCH_SIZE` and
`ANALYTICS_PROJECTION_MAX_RUNTIME_MS`. If the runtime budget is reached,
remaining buckets stay dirty for the next Worker pass.

## Shadow, Canary, and rollback

`ANALYTICS_PROJECTION_V2_MODE` supports `legacy`, `shadow`, `canary`, and
`active`. Shadow compares the schema-4 candidate locally while preserving the
schema-3 Cloud payload. Canary emits schema 4 only for IDs in
`ANALYTICS_PROJECTION_V2_CANARY_GUILDS`; active emits it for every eligible
Guild. Returning to legacy is the read/write rollback. Raw SQLite persistence
continues and Raw Cloud Event writes are never restored.

## Bounded historical backfill

`pnpm analytics:v2:backfill` is dry-run by default and requires Guild, UTC date
range, and maximum bucket count. Execution additionally requires
`--execute --confirm=PROJECTION_V2_BACKFILL`. It marks local buckets dirty in
rate-limited batches and never writes directly to a Cloud Provider.

Local Raw Retention remains a separate phase. Projection v2 does not delete Raw
Events and makes no assumption that cleanup has already run. Future cleanup
must preserve every period still needed for rebuild and must respect dirty and
checkpoint state.
