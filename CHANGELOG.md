# Changelog

All notable changes to NuviloView are documented here. The project follows semantic versioning after the current `0.1.0` baseline.

## [0.2.0-rc.1] - 2026-08-21

### Added

- One-shot, secret-excluding backup pipeline with manifests, encryption support, bounded retry, staging cleanup, and restore verification.
- Distributed singleton lease/heartbeat implementation, independent runtime monitor, and isolated failover test harness; production activation remains disabled.
- Health Score v2 data-quality gates and Preview/Shadow calibration reporting.
- Guarded Guild Reset management surfaces and API hardening; global feature flag remains disabled and production readiness is not approved.
- Security v1 production checklist; automatic containment remains disabled.
- Migration manifest, checksum journal runner, schema drift checks, bounded retention planner, CI validation, and disaster recovery runbooks.
- Durable Message History Import v2 jobs with resumable channel checkpoints, pause/resume/cancel controls, provenance, bounded retry, audit history, and exact-confirmation cleanup.

### Changed

- Dashboard freshness polling is aligned to 60 seconds.
- Internal Guild Reset backup paths are no longer returned to clients.
- Landing-page feature claims now match implemented behavior.
- Next.js and its lint package were updated from 16.2.12 to 16.3.2; the locked production dependency audit now reports zero known vulnerabilities.
- CI now installs the committed pnpm lockfile instead of relying on the intentionally ignored npm lockfile.

### Removed

- Remaining ScopeServer source references and unused compatibility utility.

### Security

- PDF text rendering is escaped, backup archives exclude secrets, local backup ACL guidance is documented, logs are sanitized, and dangerous controls fail closed.

### Known release blockers

- Production singleton/failover has not been enabled or proven across Android and Windows.
- Guild Reset lacks approved encrypted shared backup storage and an operator-tested restore procedure.
- Migration journal/baseline adoption and retention indexes remain unapplied.
- Automatic containment remains off and requires separate Guild-level approval.
- Android does not currently expose an approved remote configuration-edit path, so all-host singleton rollout and a real Android/Windows failover remain gated.
