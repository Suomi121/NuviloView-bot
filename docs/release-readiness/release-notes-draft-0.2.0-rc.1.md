# NuviloView 0.2.0-rc.1 — draft release notes

Status: **production release candidate deployed; destructive features remain gated**.

This candidate consolidates operational safety work around backup, runtime ownership, monitoring, Health v2 data quality, guarded administration, migration management, retention, Message History Import v2, CI, and recovery documentation. It does not bypass dangerous production feature gates.

## Configuration defaults

- Distributed singleton: disabled until Android can receive and verify a fixed host ID and singleton configuration.
- Guild Reset: disabled globally and per-Guild unless separately approved.
- Security automatic containment/restore: disabled; Shadow/monitoring is the safe evaluation mode.
- Health v2: Preview/Shadow, not the sole production decision metric.
- Retention cleanup: Dry Run by default; execution requires indexes and an explicit command.

## Database notes

Eight checksum-protected additive migrations are current in production. Five existing schema groups were adopted into the journal, and the journal, retention indexes and Message History Import v2 schema were applied transactionally. No DROP, TRUNCATE or Analytics row deletion was used. See `production-execution-20260821.md`.

## Verification completed

- Migration checksum and static schema-drift validation.
- Read-only live migration-state and retention candidate review.
- Token leak scan, syntax check, lint, typecheck, automated tests, and Next.js production build.
- Isolated real-DB distributed runtime/failover checks passed 8/8; no production host transfer was attempted.
- Mobile layout review of landing, dashboard, and developer surfaces.
- Dual-drive checksum and restore verification for backup set `20260821-204609-7c9505a6`.
- Production Web/API health, Windows Bot heartbeat, Message History Import provenance and independent monitor delivery.

## Known limitations and blockers

- No real Android/Windows production failover evidence.
- Guild Reset backup durability/restore readiness is insufficient for destructive production use.
- Security automatic containment remains Shadow because trusted-actor and permission gates are incomplete.
- Backup automatic scheduling remains intentionally disabled until the one-shot worker is configured and restore-verified.
- Server backup and Guild Reset backup encryption are not configured.
- The locked dependency audit is clean after upgrading Next.js and eslint-config-next to 16.3.2.

## Configuration changes

- Production Web and Windows Bot: `MESSAGE_HISTORY_IMPORT_V2_ENABLED=true`.
- Vercel and GitHub Actions: synchronized `BOT_MONITOR_TOKEN` / `NUVILOVIEW_BOT_MONITOR_TOKEN` secret pair.
- Health v2 remains Preview/Shadow; Guild Reset, distributed singleton and Security automatic containment remain off.

## Rollback

Keep all dangerous flags off, stop the candidate runtime, and return to the previous known-good application build. Additive DB objects should remain until a reviewed remediation is approved. Preserve backup, migration, security, and execution audit evidence.
