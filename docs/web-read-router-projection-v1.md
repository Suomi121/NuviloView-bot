# Web Read Router Projection v1

NuviloView Web Analytics reads compacted snapshots through one server-side
contract. The default priority is Supabase, then Turso. Neon is excluded unless
`MULTI_DB_WEB_READ_NEON_COMPAT_ENABLED=true` is explicitly set. This setting is
Analytics-only and does not alter Supabase Web Auth.

## Read-path inventory

| Area | Previous path | Projection v1 path |
| --- | --- | --- |
| Dashboard totals/trends | Legacy PostgreSQL raw aggregation | Guild Current + Guild Daily |
| Message analytics | `discord_message` scans | Guild/Channel/User Daily |
| Reactions | raw reaction rows | Guild/Channel Daily |
| Voice | raw voice sessions | Guild/Channel Daily |
| Members and retention | raw member/message/voice joins | Guild/User Daily |
| History analytics | imported raw-message queries | the same compacted projections |
| Bot/Worker/Provider status | mixed local/legacy status | Runtime + Sync Status snapshots |

Authentication, sessions, user settings, developer operations, goals, support,
and import control state remain control-plane reads. They are not Analytics
fallback candidates.

## Contract

`lib/web-read-router.mjs` owns provider priority, infrastructure-only fallback,
freshness, Last Known Good, and read metrics. It exposes exact point reads for
Guild Current, Guild Daily, Channel Daily, User Daily, Runtime, and Sync Status,
plus one bounded Analytics bundle read. API routes must authorize the session
and Guild before invoking the router.

Freshness is based on the configured Analytics compaction interval. Projection
`lastUpdatedAt` remains the time its analytical content last changed. When that
content is unchanged, a current Sync Status snapshot may separately provide
`observedAt`, but only when the selected provider is healthy, its circuit is
closed, and pending/retry/dead-letter counts are all zero. This prevents an
inactive but fully synchronized Guild from being mislabeled stale without ever
promoting an unverified old snapshot to fresh.

- `fresh`: at most 1.5 intervals old
- `stale`: at most 4 intervals old
- `very_stale`: older than 4 intervals or a Last Known Good fallback
- `unavailable`: no usable snapshot

The browser performs an initial Analytics read, one read at `nextUpdateAt`, and
one visibility recovery read only when that time has passed. The one-second
countdown updates DOM text only. Runtime status is a separate bounded 60-second
point-read poll.

## Explicit Projection v1 limitations

Projection v1 does not contain message bodies, event-time roles, hourly heatmap
buckets, Bot/human separation, or sub-day onboarding timestamps. The API and UI
report these limitations instead of querying raw Cloud events or inventing
values. Role-filtered Analytics is rejected until a reviewed projection exists.

## Query reduction

The removed dashboard route contained 12 direct `pool.query` call sites and the
removed community Analytics service contained 22. Their replacement performs
one exact Current point read plus one bounded snapshot-family read against the
selected Cloud replica. When the analytical content timestamp is old, one exact
Sync Status point read verifies that the replica is caught up. The Goals route
retains one control-plane query for the user's saved targets, while its progress
values now use the same Projection bundle. Migrated Analytics routes contain no
direct Pool and no raw event-table query.

## Operational flags

```env
MULTI_DB_WEB_READ_ENABLED=false
MULTI_DB_WEB_READ_NEON_COMPAT_ENABLED=false
```

Both defaults are safe. Provider credentials remain server-only and no browser
response contains them.
