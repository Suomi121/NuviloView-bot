# Sync Worker Recovery Phase 1 — production review candidate

Scope: local code and isolated tests only. Base: `f2c61c5f4a251ee02317c5a814429ba76b507020` (Bot runtime checkpoint); branch: `fix/worker-supervisor-recovery`. This is not a Web deployment candidate. Do not deploy this older runtime checkout as the Web application.

## Incident evidence and certainty

The supplied production checkpoint records Worker death at approximately 2026-09-24 18:23:04 JST, after its 18:22:09.875 heartbeat and the providers' 18:22:56 successful writes. An unhandled EventEmitter error was recorded, but the original emitter, error code and full stack were not preserved. **Crash root cause remains PARTIAL.**

The supervisor failure is identified: an invalid coprocess output FD leaves the previous `raw_line` populated, so the loop repeats the last line instead of reaching child wait/restart. The finite isolated reproducer repeats the same line five times; it deliberately does not generate 3.49 million lines.

Turso credential expiry at 2026-09-26 11:20:44 JST occurred approximately 41 hours later. It is a recovery blocker, not evidence of the original crash cause.

## Changes

- Shell retains runner singleton, configuration validation, bounded restart delays (1/2/5/10/30/60 seconds), network delay and crash cooldown.
- A small Node helper owns the child process. Output streams are observers; their end/error/close cannot prevent child exit detection. Final lines flush once. Exit/close completion is deduplicated, with a bounded drain deadline for inherited open pipes.
- Actual child PID and Linux `/proc` start ticks are recorded. Missing processes are STOPPED; mismatched identities fail closed. A live recorded PID prevents another spawn and preserves diagnostic state, including when the PID now belongs to a different process.
- Heartbeat uses the Worker's metrics `generatedAt`, not output-log modification time. The stale threshold is the greater of 120 seconds and four configured metrics intervals. Startup has bounded grace; stale live children become DEGRADED, never automatically killed.
- Status output no longer presents stale saved provider/circuit/queue metrics as current health.
- `uncaughtExceptionMonitor` records timestamp, origin, name, code, stack and cause code, with redaction. It does not install an `uncaughtException` recovery handler or change native fatal termination. Preloading installs the observer before Worker module loading; direct CLI use also installs it without duplication.
- Output logging remains redacted and now has in-run size rotation (active + three numbered archives) and a 100 ordinary-lines/second cap. One fatal diagnostic is reserved despite rate limiting. Oversized lines are omitted rather than split into potentially exposed secret fragments. Existing runner/archive rotation remains in place.
- No ingestion, queue-processing, retry classification, provider, projection, schema, Bot, Auth, Entitlement or Web code was changed.

## EventEmitter audit

| Area | Evidence | Disposition |
|---|---|---|
| Supabase/optional Neon PostgreSQL pools | `lib/sync/providers/registry.mjs` creates `pg.Pool` without a pool `error` listener | Credible candidate for an idle-client error, **not proven as this incident's emitter**. Reported; no speculative catch added. |
| Legacy PostgreSQL Worker | `scripts/run-sync-worker.mjs` creates a pool without a pool `error` listener | Same candidate, but legacy path was not established as active in this incident. |
| Turso transport | Provider uses promise-based execute/batch calls; operation failures feed existing retry classification | No original socket/emitter identity can be recovered from the available trace. No blanket socket listener added. |
| Worker local persistence | SQLite and atomic metrics writes; no newly identified app-owned unobserved file-stream emitter | Existing failures retain their current semantics. |
| New supervisor child/stdout/stderr | Explicit child spawn/error/exit/close and stream error/end/close observers | Covered by isolated real/fake child tests. Stream failure does not imply child death. |

API rationale: [Node process monitor documentation](https://nodejs.org/api/process.html#event-uncaughtexceptionmonitor) and [node-postgres pooling documentation](https://node-postgres.com/features/pooling). The monitor supports diagnosis; it does not prove or fix the unknown original emitter.

## Queue replay review (no production replay)

The supplied checkpoint, **not a new live measurement**, records SQLite quick_check=ok, WAL enabled, foreign-key inconsistencies=0, DLQ=0, 683 dirty buckets, and each of Supabase/Turso with 30 event deliveries plus one runtime snapshot pending, attempts=0.

- Local domain event and outbox insertion are transactional. Stable event IDs and checksums detect duplicate/conflicting payloads.
- Provider delivery rows are independently leased; expired processing locks recover through the normal Worker path. No manual queue SQL is necessary or approved.
- PostgreSQL and Turso insert events with conflict protection and verify checksums. Snapshot versions/checksums prevent stale overwrites and detect conflicts.
- Unchanged snapshot payloads skip provider writes. Analytics source sequence / last aggregated sequence retains late-arriving dirty work across aggregation.
- Existing retry/circuit policy stays unchanged. Circuit metadata must recover through normal timed probes; it must not be edited to CLOSED manually.
- These are at-least-once/idempotent mechanisms, not an exactly-once claim. Reconciliation after replay remains mandatory. Real cloud replay was not tested in this phase; isolated PostgreSQL integration tests without configured test DB remain skipped.

## Validation and limitations

The supervisor target suite covers normal output, clean/nonzero/fatal exits, rejected spawn, early stdout/stderr close, invalid-FD simulation, exit/close deduplication, inherited pipes, signal mapping, PID reuse, stale saved RUNNING, stale heartbeat without kill, bounded logs/redaction, and the actual shell launcher against a dummy child. An executable harness runs the unchanged shell crash policy with dummy crashes and replaces only sleeping/logging/environment helpers; it verifies escalating delays and cooldown without wall-clock waits.

Tests run on Windows Node 24 with Git Bash. The launcher fixture normalizes Windows `node -p` CRLF to emulate Termux LF; production validation is not weakened. Linux start-tick behavior has unit coverage but no live Termux execution in this phase. Before deployment, review the patch and run its dummy-only checks on a non-production Linux/Termux environment where available.

Final local results (this runtime base, not the newer Web branch): supervisor 23 PASS; supervisor + existing Worker/Multi-DB tests 66 PASS / 1 SKIP; full suite 459 PASS / 8 SKIP / 0 FAIL (467 total). TypeScript PASS; full lint 0 errors / 9 existing warnings, changed-source lint clean; tracked module syntax 155 PASS plus explicit syntax checks of new modules PASS; shell syntax PASS; token scan PASS; broader changed-file secret scan 9 files / 0 findings; diff whitespace check PASS. A synthetic DB URL in the redaction test initially triggered the broader scanner and was explicitly marked `dummy`; the same redaction assertion was rerun and passed. Skipped database tests were not enabled against production.

## Safe production recovery order — NOT EXECUTED

1. Obtain separate production recovery approval and review only this patch against the actual current Bot runtime revision. Keep unrelated Web/Entitlement work out of the update.
2. Preserve the incident evidence (including the existing 245 MB / 521 MB logs), check free space, and retain the existing SQLite backup policy. Do not truncate/delete incident logs to make startup work.
3. Under separate credential authorization, replace the expired Turso credential, verify the intended provider/account and a read-only connectivity check. Never start the production Worker against the known-expired credential.
4. Stop the old stuck supervisor using the reviewed existing stop procedure. If it does not exit within the bounded timeout, stop the recovery procedure and request approval for exact-process termination; do not remove its lock/PID files manually or launch a competing runner. Confirm no Worker/monitor remains.
5. Apply the reviewed Worker-only code. Start one runner through the normal entry point. It reconciles absent-PID evidence itself; any live ambiguous PID yields DEGRADED and refusal. It does not use historical RUNNING or circuit snapshots as proof of health.
6. Use the normal Worker path and an approved small batch for pending delivery/compaction. Do not reset retry counts, force circuit state, delete queue rows, or manually run cloud UPSERTs. Verify each provider's recovery independently.
7. Check Worker heartbeat advances, provider health/circuit status is fresh, pending/processing/retry/DLQ drain as expected, dirty buckets clear or checksum-skip, reconciliation has no missing/checksum mismatch, and Bot/collector are unaffected.
8. On unexpected fatal/restart storm, capture the new redacted fatal record, stop further rollout, and follow the approved safety procedure. Never hide a crash by keeping a fatally broken Worker alive.

This phase performed **no production connection, restart, configuration/credential update, queue replay, database mutation or deployment**. No production logs were deleted or truncated.
