# Migration inventory — 2026-08-21

This inventory combines the source manifest with read-only PostgreSQL catalog checks. No migration was applied and no application row was changed during the review.

| Migration | Risk | Database state | Journal state | Approval |
| --- | --- | --- | --- | --- |
| `20260814-nuke-protection-v1` | Medium | Required tables/index exist | Journal unavailable | Standard reviewed execution |
| `20260816-distributed-runtime` | Medium | Lease/heartbeat tables and index exist | Journal unavailable | Standard reviewed execution |
| `20260816-reaction-roles` | Medium | Rule table/index exist | Journal unavailable | Standard reviewed execution |
| `20260821-branding-schema` | Low | Branding table exists | Journal unavailable | Standard reviewed execution |
| `20260821-migration-journal` | Low | Pending | Not applicable | Apply first in a maintenance window |
| `20260821-retention-indexes` | Medium | Pending | Journal unavailable | Explicit `--approve=20260821-retention-indexes` |
| `20260821-security-v1` | High | Sample required columns/index exist | Journal unavailable | Explicit `--approve=20260821-security-v1` |

The first four and Security v1 are `present_untracked`: structural evidence exists, but there is no journal table to prove which exact SQL/checksum created it. They must not simply be re-run and marked applied. The operator should first create the journal, compare the complete live schema with every migration check, and use a reviewed baseline-adoption procedure in a later phase.

## Runner contract

- `npm run db:migrate:plan` is read-only and reports pending journal entries.
- `npm run db:migrate` is the only managed execution path and still requires an explicit approval argument for marked migrations.
- Existing untracked structures are not re-run: each must be structurally verified and named with `--adopt-present=<migration-id>`. A partially present migration always stops for manual remediation.
- The runner verifies SHA-256, takes a PostgreSQL advisory lock, and executes each migration in its own transaction.
- `npm run db:bootstrap` is a legacy compatibility path and refuses to run without `--execute-bootstrap`.
- `npm run migration:validate` and `npm run migration:drift:static` require no DB connection.
- `npm run migration:drift -- --report-only` reads catalog state only.

## Rollback position

All current managed migrations are additive. There is no automatic down migration because blind rollback could destroy live data or invalidate newer rows. Rollback means disabling the dependent feature, restoring the prior application build, and preparing a reviewed schema remediation or backup restore. Production `DROP` or `TRUNCATE` is never part of this workflow.

## Required decision before production migration

1. Take and restore-verify an encrypted backup.
2. Resolve `present_untracked` baseline adoption without altering existing objects.
3. Review index build load and maintenance window.
4. Confirm flags remain off: distributed singleton, Guild Reset, and Security auto containment.
5. Run plan, record checksums, approvals, operator and time.
