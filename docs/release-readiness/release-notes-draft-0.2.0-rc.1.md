# NuviloView 0.2.0-rc.1 — draft release notes

Status: **release candidate source prepared — not yet tagged, released, merged, migrated, or deployed**.

This candidate consolidates operational safety work around backup, runtime ownership, monitoring, Health v2 data quality, guarded administration, migration management, retention, Message History Import v2, CI, and recovery documentation. It does not bypass dangerous production feature gates.

## Configuration defaults

- Distributed singleton: disabled until every host is configured and real failover is approved.
- Guild Reset: disabled globally and per-Guild unless separately approved.
- Security automatic containment/restore: disabled; Shadow/monitoring is the safe evaluation mode.
- Health v2: Preview/Shadow, not the sole production decision metric.
- Retention cleanup: Dry Run by default; execution requires indexes and an explicit command.

## Database notes

No DB change is performed by installing or building this source. The migration plan contains eight checksum-protected additive migrations. Live catalog review found existing objects without a migration journal; baseline adoption and the pending journal/index/import migrations require a maintenance-window decision. See `migration-inventory-20260821.md`.

## Verification completed locally

- Migration checksum and static schema-drift validation.
- Read-only live migration-state and retention candidate review.
- Token leak scan, syntax check, lint, typecheck, automated tests, and Next.js production build.
- Isolated distributed runtime/failover checks; no production host transfer.
- Mobile layout review of landing, dashboard, and developer surfaces.

## Known limitations and blockers

- No real Android/Windows production failover evidence.
- Guild Reset backup durability/restore readiness is insufficient for destructive production use.
- External alert delivery credentials and response process require operator verification.
- Backup automatic scheduling remains intentionally disabled until the one-shot worker is configured and restore-verified.
- The locked dependency audit is clean after upgrading Next.js and eslint-config-next to 16.3.2.

## Rollback

Keep all dangerous flags off, stop the candidate runtime, and return to the previous known-good application build. Additive DB objects should remain until a reviewed remediation is approved. Preserve backup, migration, security, and execution audit evidence.
