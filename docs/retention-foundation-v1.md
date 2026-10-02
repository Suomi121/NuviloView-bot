# NuviloView Retention Foundation v1

Status: migration review candidate only. Raw deletion, scheduling, Production migration, and runtime cutover are not implemented.

## Safety boundary

- `RETENTION_FOUNDATION_MODE` accepts only `off` and `shadow`; default is `off`.
- There is deliberately no `active` or `delete` mode.
- No Bot/Worker hot path calls this repository.
- No Cloud schema or Cloud Raw write is added.
- Migration 8 is additive and has only new SQLite tables/indexes.
- Production must not receive migration 8 without a separate explicit approval.

## Audited baseline

- `origin/main`: `3bd04b6d7cfa69a97cb413f9620aed94d2be3ea7`
- Termux runtime: `7f24c5675febfc4f0d6b7874d5651e36ed603f78`
- The drift is PR #20/#21 Web-only Insight presentation/entity-resolution work. It has no Bot, Worker, SQLite migration, Projection generation, Sync, or runtime behavior change.
- Runtime and status use the same SQLite path: `./data/canary-nuviloview.sqlite` under the Termux project. The old 565 KiB status value came from a stale cached `Android/runtime/storage-health.json`, while the live DB was about 15.1 MB with a 5.28 MB WAL. The independent branch `fix/status-live-sqlite-health` / commit `a6afe47` refreshes a read-only live snapshot and reports main/WAL/SHM/page/freelist/quick-check. It is intentionally not mixed into this migration candidate.

## Projection dependency map

| Projection | Message | Reaction | Voice | Member | Rebuild behavior |
| --- | --- | --- | --- | --- | --- |
| `guild_current` | full `message_event_log` | operation counts from full `reaction_events`; current counts from `local_reaction_state` | durations from retained `local_voice_session`; activity timestamp from `voice_events` | operation counts from full `member_events`; current count from state | one new event dirties and rebuilds the all-time bucket |
| `guild_daily` | date-limited Raw | date-limited Raw | overlapping retained sessions plus date-limited activity Raw | date-limited Raw | one UTC day |
| `channel_daily` | date/channel Raw | date/channel Raw | overlapping retained sessions | not applicable | one UTC day/channel |
| `user_daily` | date/user Raw | date/user Raw | overlapping retained sessions | date/user Raw | one UTC day/user |

History Import rebuilds Message-derived local state from `message_event_log`, and late events can re-dirty an old daily bucket. Therefore dirty=0, provider delivery, and checksum agreement alone do not make Raw deletable.

## Selected baseline model

`guild_current` uses a fixed-size local baseline of cumulative operation counters through an exclusive cutoff:

- message create/edit/delete/reply counts
- reaction add/remove counts
- member join/leave counts
- last message/activity timestamps

The remaining exact current state is reused rather than copied:

- `message_events` tombstones/current message state
- `local_message_active_member` for exact distinct Message participants
- `local_reaction_state`
- `local_voice_session` (including open/cross-boundary sessions)
- `local_member_state` and `local_member_guild_state`

Current material is `fixed baseline + recent Raw + retained state`.

Closed daily/channel/user buckets reuse the existing immutable `sync_snapshot` payload and checksum. Foundation stores only its key/version/checksum/finalization evidence; it does not duplicate Projection payload JSON. A changed historical snapshot fails closed with `BASELINE_SNAPSHOT_CHANGED`.

`local_voice_session` is state, not a Raw cleanup target in v1. Its later compaction is a separate phase.

## Dedupe decision

Rejected:

- Full permanent Event-ID ledger: correct but grows one row per Raw event and defeats retention.
- Time-bounded ledger: cannot identify an old replay after the ledger expires.
- Bloom/filter-only evidence: false positives can discard real events.
- Global `source_sequence`: current domains mix millisecond timestamps and process-local `now()*1000` sequences; it is not a durable cross-domain monotonic clock.
- Hash-only fingerprints: collision handling cannot be authoritative without original identity.

Selected:

- Recent-window events continue to use Raw primary keys and existing current-state transition guards.
- Pre-boundary events are never automatically applied. They enter the sparse `retention_late_event_queue`, keyed by the exact stable Event ID.
- The same late Event ID is rejected on replay and increments only a replay counter.
- A genuinely new late event remains visible for deterministic/manual repair; it is never silently dropped or automatically double-counted.

This queue grows with exceptional late arrivals, not with every Discord event. A future operational retention policy for resolved queue rows is required before active cutover.

## Finalization contract

Finalization means that aggregate correctness before `finalized_through_at` has been transferred to a baseline/snapshot. It does not mean that any Raw was deleted.

A bucket is blocked unless all conditions hold:

1. Projection tracking exists, `dirty=0`, and aggregated sequence has caught up.
2. Projection contract is schema 4 / Projection v2.
3. Every required provider delivery is synced with the same remote checksum.
4. Reconciliation is not older than the last required provider delivery.
5. The late-event grace period has ended.
6. No History Import job is queued/running/paused/failed/stalled for the Guild.
7. No open Voice session started before the cutoff.
8. No pre-cutoff Outbox item remains incomplete.
9. Closed daily buckets end no later than the cutoff.

Provider availability after successful delivery does not permanently block the boundary; finalization records the reconciliation evidence at that point. Any later snapshot change invalidates the historical baseline.

## Domain-specific late events

| Domain | Before-boundary behavior | Repair rule |
| --- | --- | --- |
| Message create/edit/delete/reply | quarantine by Event ID; do not touch Raw/state/baseline | reopen affected current/day/channel/user projections; use archived source or a reviewed deterministic counter correction |
| Reaction add/remove | quarantine; retain `local_reaction_state` | repair both operation counters and current state only after ordering is proven |
| Voice join/move/leave | finalization is blocked by open pre-boundary session; later old transitions quarantine | retained session is the duration authority; repair/reopen affected day/channel/user buckets |
| Member join/leave/update | quarantine; retain member state | repair operation counters and member snapshot with reviewed ordering |

No domain uses timestamp ordering alone to authorize an old correction.

## History Import

- Any non-completed/non-cancelled job blocks finalization.
- Existing stable Message IDs/current-state tables remain retained.
- After a boundary exists, pre-boundary import records must pass the same late-event gate before the existing Message repository.
- Replaying the same imported Event ID creates one queue row and no aggregate mutation.
- Active hot-path interception is intentionally not wired in v1 Shadow; it is a cutover prerequisite.

## Outbox and reconciliation

Raw retention and Outbox retention stay separate. Incomplete pre-cutoff Outbox rows block finalization. Synced Outbox cleanup is not part of this change. Current truth remains `sync_snapshot` plus per-provider delivery/checksum state; delivery history is supporting evidence, not the Projection baseline itself.

## Proposed SQLite migration 8

### `analytics_retention_foundation`

- PK: `projection_key`
- Identity: `projection_kind`, `guild_id`, `date_utc`, `channel_id`, `user_id`
- State: `shadow|eligible|finalized|reopened|blocked`
- Boundary/evidence: `finalized_through_at`, diagnostic `source_sequence`, `snapshot_version`, `snapshot_checksum`, `reconciled_at`, grace timestamps
- Current-only material: bounded `baseline_material_json` (max 64 KiB), `baseline_checksum`
- Metrics: baseline build duration, compare count/mismatch, last compare time
- Indexes: `(state, finalized_through_at, guild_id)` and `(guild_id, projection_kind, date_utc)`

### `retention_late_event_queue`

- PK: exact `event_id`
- Domain/partition/type/time/source metadata
- Reviewed payload (max 256 KiB), checksum, status, reason, replay count
- Indexes: `(status, first_seen_at, guild_id)` and `(domain, partition_key, source_sequence)`

There is no full retained ledger and no new Cloud table. Both SQLite tables are `STRICT`; the primary tables are `WITHOUT ROWID`. Existing tables are not rewritten.

## Growth model

Production observed Raw was approximately 2.0 MB across 1,028 Message, 77 Reaction, 92 Voice, and 1,485 Member rows. The observation window is not reliable enough to claim a real daily rate. As a deliberately conservative scenario, repeating that whole observed sample once per day gives roughly 60/180/730/2,190 MB at 30/90/365/1,095 days before indexes/WAL.

Foundation growth follows Projection buckets, not events. At an intentionally high 1,000 finalized Projection rows/day and about 0.5 KiB metadata/row, the new metadata would be about 14.6/43.9/178/535 MiB at 30/90/365/1,095 days. Real current Production has about 1,616 snapshots, so the initial order of magnitude is below 1 MiB plus indexes. Resolved late-event queue growth must be monitored and bounded in a later policy.

Isolated stress results on this host:

| Raw events | Raw DB | Baseline build | Baseline JSON | lookup p50/p95/p99 | compact retained DB after simulated Raw removal |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 41,467,904 B | 45.84 ms | 234 B | 0.015/0.056/0.111 ms | 425,984 B (1.0273%) |
| 1,000,000 | 416,313,344 B | 455.61 ms | 235 B | 0.018/0.061/0.111 ms | 425,984 B (0.1023%) |

Both runs used WAL, had zero busy errors, zero WAL bytes after checkpoint, and `quick_check=ok`. Physical growth from the single Foundation row reused already allocated pages (0 B observed); the logical baseline size is reported separately.

## Backfill and cutover

1. Apply additive migration only after explicit approval and an online backup/restore check.
2. Keep mode `off`; verify schema and runtime metrics.
3. Set `shadow` for an explicit isolated/canary invocation only.
4. Build bounded baselines from one stable cutoff, recording source/checksum evidence.
5. Continue normal ingestion; compare full-Raw material against baseline+recent Raw.
6. Require mismatch=0 for Message/Reaction/Voice/Member and all Projection kinds.
7. Canary a Guild, then separately review hot-path late-event gating.
8. Only a later phase may add retention dry-run/canary. No DELETE scheduler exists here.

The baseline build is deterministic and idempotent. It uses short indexed/aggregate reads and one upsert per Projection; no provider query runs in the Bot hot path.

## Atomicity and crash behavior

v1 adds no Raw+ledger dual-write, so it cannot create a split-brain pair of those records. A future active gate must classify/quarantine within the same local SQLite transaction as the attempted Raw/state transition. A crash before commit leaves neither mutation; a crash after commit leaves the exact late Event ID receipt. Large multi-bucket transactions remain prohibited.

## Metrics

Local repository metrics expose Foundation schema version, baseline count/bytes, cutoff range, build duration, Shadow comparisons/mismatches, sparse dedupe entries, late-event count, and open late-event count. Classification returns lookup latency for local aggregation. No metrics are sent to Cloud by this change.

## Rollback

Before migration: revert the candidate commit/branch.

After a future additive migration but before cutover: set `RETENTION_FOUNDATION_MODE=off` and keep the unused additive tables. Do not drop them in an incident. The existing Projection/Raw path remains authoritative because no runtime caller was changed.

After a future Shadow run: set mode off. Shadow rows can remain for forensic comparison; no Raw was deleted. Destructive rollback SQL is intentionally absent.

## Remaining gates before any Raw deletion

- explicit migration approval and Production-sized copy validation
- active transaction-bound late-event interception in all four domain repositories
- Shadow mismatch=0 on real Production data over the grace window
- History Import replay and cross-boundary Voice canary
- resolved late-event operational policy and alerts
- separate retention dry-run/canary approval
