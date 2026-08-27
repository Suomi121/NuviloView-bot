# Analytics Compaction v2

Analytics Compaction v2 keeps Discord message content and raw Message events in
the local SQLite database. For explicitly enabled Canary Guilds, Cloud replicas
receive deterministic analytical projections through the existing snapshot
delivery pipeline instead of receiving one `replica_event` row per message.

The feature is opt-in. `ANALYTICS_COMPACTION_ENABLED` defaults to `false`, and
only IDs listed in `ANALYTICS_COMPACTION_GUILD_IDS` are eligible.

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

## Scheduling and Web refresh

The default projection interval is 900 seconds. Dirty buckets are aggregated at
most once per interval, while a previously unseen bucket may be built
immediately. The Web countdown updates text in the browser once per second and
performs a single snapshot fetch when the countdown reaches zero. There is no
one-second or one-minute Cloud polling loop.

## Send-reduction metrics

SQLite tracks `raw_events_seen`, `snapshots_built`, `snapshots_changed`,
`snapshots_skipped`, total Provider writes, per-Provider writes, and the derived
write-reduction ratio. These counters are operational telemetry and contain no
message content.

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
