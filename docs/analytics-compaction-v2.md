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
| Reaction analytics event | Legacy direct Cloud write | Out of scope for the prohibited full Reaction Local-First migration |
| Voice session event | Legacy direct Cloud write | Out of scope for the prohibited full Voice Local-First migration |
| Member lifecycle event | Legacy direct Cloud write | Out of scope for the prohibited full Member Local-First migration |
| `local_message_daily_stats` and active-member rows | Local summary | Source for projections; not copied directly |
| `analytics_snapshot` | Snapshot | Provider UPSERT only when the semantic checksum changes |
| Guild/runtime/sync status snapshots | Snapshot/control | Existing bounded snapshot path retained |
| Discord OAuth, Web sessions, user settings | Control/Auth | Unchanged; Supabase Web Auth remains separate |
| Message History Import v2 job/control tables | Control | Existing PostgreSQL control path retained |
| Message History Import v2 `discord_message` batch INSERT | Legacy direct raw Cloud write | Follow-up blocker described below |

The Cloud `analytics_snapshot` table is reused as the provider-neutral
projection table. Its `aggregate_id` identifies one of these bounded buckets:

- `v2:guild:{guildId}:current`
- `v2:guild:{guildId}:daily:{YYYY-MM-DD}`
- `v2:guild:{guildId}:channel:{channelId}:daily:{YYYY-MM-DD}`
- `v2:guild:{guildId}:user:{userId}:daily:{YYYY-MM-DD}`

Each payload contains counts and timestamps only. Raw message content is never
included. Supabase and Turso receive the same semantic checksum and version;
Neon remains optional compatibility storage.

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

## Follow-up blocker: Message History Import

`lib/message-history-import-worker.mjs` still performs a batched direct INSERT
into PostgreSQL `discord_message`. Moving that job safely requires preserving
pause/resume/cancel checkpoints, duplicate counts, imported-data deletion, and
the existing Web search contract. It is intentionally isolated from this
runtime change and must be the first follow-up phase:

1. write imported messages to SQLite `message_event_log` transactionally;
2. persist the import checkpoint independently from raw message storage;
3. mark the same projection buckets dirty;
4. keep only explicit recent-message/search data in Cloud, with retention;
5. migrate deletion and reconciliation tests before removing the legacy INSERT.

Until that phase is complete, operators must treat History Import as a legacy
raw-Cloud path. Analytics Compaction v2 does not silently claim otherwise.
