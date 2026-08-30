# Event Local-First Expansion v1

## Scope

This phase moves Discord Reaction, Voice, and Member analytics events behind
the same local-first boundary used by the Message domain:

```text
Discord gateway
  -> SQLite raw event/state
  -> dirty projection buckets
  -> checksum skip
  -> Supabase + Turso compacted snapshots
```

Raw event payloads are not placed in `sync_outbox`. Neon remains optional and
is not part of the required projection contract. Web authentication, OAuth,
settings, moderation, and runtime-control data are unchanged.

## Feature flags

```ini
EVENT_LOCAL_FIRST_ENABLED=false
EVENT_LOCAL_FIRST_GUILD_IDS=
EVENT_LOCAL_FIRST_REACTION_ENABLED=true
EVENT_LOCAL_FIRST_VOICE_ENABLED=true
EVENT_LOCAL_FIRST_MEMBER_ENABLED=true
LOCAL_FIRST_ALL_GUILDS_ENABLED=false
```

Canary/rollback mode requires the global Event flag and an explicit Guild
allowlist. Final mode additionally sets `LOCAL_FIRST_ALL_GUILDS_ENABLED=true`;
then every normal connected Guild uses SQLite and the allowlist is retained only
as rollback metadata. In either mode, routed Guilds never dual-write Reaction,
Voice, or Member raw rows to Cloud. Local storage, local writes, snapshot sync,
the Sync Worker, and Analytics Compaction must already be enabled.

## Local schema

Local migration 7 is forward-only and adds:

- Reaction transition metadata and `local_reaction_state`.
- Voice transition metadata and `local_voice_session` with one open segment per
  Guild/user.
- Member transition metadata, `local_member_state`, and
  `local_member_guild_state`.

Discord IDs and stable event IDs remain text. SQLite uses WAL, transactions,
and primary/unique keys for idempotency.

## Event contracts

### Reaction

Add/remove transitions are persisted locally. Replaying the same state does
not append another raw event. The current projection is derived from the local
reaction state, so a remove observed before cutover cannot leave a negative
balance. Projections expose reaction count, unique reactors, reacted messages,
and bounded top reactions. Current counts represent active local state; Daily
counts preserve the prior analytics meaning and count observed add operations,
while add/remove operation totals remain separately visible.

### Voice

Join opens a segment, move closes the previous segment and opens the next, and
leave closes the current segment. Sessions crossing UTC midnight dirty every
affected daily bucket. On restart, current Discord voice state is
reconciled with open SQLite segments. When the Bot cannot know the real end
time, the segment is marked recovered with a null duration; no duration is
invented.

### Member

Join, leave, and role updates use a local member-state row for duplicate
suppression. Startup sync establishes a baseline without counting it as a join.
The exact Discord `memberCount` observed with the event is retained separately
for the current projection.

## Projection contract

Projection schema v3 keeps compatibility fields and adds nested `reactions`,
`voice`, and `members` summaries. Projection keys remain:

- Guild Current
- Guild Daily
- Channel Daily
- User Daily

Only affected buckets are marked dirty. Semantic checksum equality leaves the
snapshot version unchanged and produces zero provider writes.

## Canary rollout

1. Confirm the Bot, Worker, SQLite, Supabase, and Turso are healthy with an
   empty queue and DLQ.
2. Add one existing Analytics Compaction Canary Guild to
   `EVENT_LOCAL_FIRST_GUILD_IDS`.
3. Enable `EVENT_LOCAL_FIRST_ENABLED` and restart the Bot gracefully.
4. Exercise a small Reaction/Voice/Member sample and verify SQLite raw rows,
   projections, equal Supabase/Turso checksums, and no raw Cloud event rows.
5. Restart Bot and Worker, verify voice recovery and persistence, then observe
   runtime stability for at least five minutes.

## Rollback

Set `EVENT_LOCAL_FIRST_ENABLED=false` and gracefully restart only the Bot. Do
not delete the SQLite file or local raw rows. Message Local-First, History
Import, Multi-DB Sync, and existing compacted snapshots remain independent.
Before rollback, record local raw/projection counts so that a later controlled
reconciliation can explain the routing boundary.

## Final all-Guild mode

After Canary validation, `LOCAL_FIRST_ALL_GUILDS_ENABLED=true` changes Message,
Reaction, Voice, Member, and Analytics Compaction routing together. Startup
fails closed when any required local domain or writable SQLite is unavailable.
Legacy raw writers remain only as an explicit emergency rollback adapter and are
not called by the normal all-Guild event path.

## Known compatibility boundary

The Cloud analytics snapshot endpoint reads Projection v3 without extra
polling. Rich legacy community views that require historical role inventory or
raw, pre-Canary Cloud rows continue to use their existing read path until a
separate bounded-projection UI migration is validated; this phase does not
guess missing historical role or voice data. The legacy Bot writers remain
reachable only for Guilds outside the staged allowlist so the Canary can be
rolled back without losing unrelated Guild analytics. Completion requires all
currently supported Guilds to enter final all-Guild mode; this fallback is not
a dual-write path.
