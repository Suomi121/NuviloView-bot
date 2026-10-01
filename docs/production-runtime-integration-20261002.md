# Production runtime integration audit — 2026-10-02 (JST)

## Fixed baselines
- Current Web source: `c1c24ee4badfc2871ecb182050b5fddbe319f080`.
- Current Web deployment: `dpl_7Jez9h9H8jC5UYTtdDC2vvDM5B43`.
- Termux production Git HEAD: `413a03d60511c3e64ab9f853dfa56fba4bf45bb0`.
- Merge base: `7f24c5675febfc4f0d6b7874d5651e36ed603f78`.
- Full symmetric history has exactly two production-only commits: `f2c61c5` (guild onboarding), `413a03d` (worker supervisor recovery/diagnostics). No additional production-only commits were found.
- Production tracked working tree is clean; no nonignored untracked files.
- All 101 changed paths between production and main are listed below. This list is the entire Git diff, not a selected feature list.

## Running code and non-Git state
Read-only SSH inspection matched PID files, process executables, script arguments and working directories:
Bot 20529 and Bot runner 20345 run from `~/NuviloView-bot`.
Worker 23155 and runner 22946 run from that same directory; the Worker loads the tracked crash-diagnostics preload.
The Node supervisor process is separate from the shell runner.

Ignored runtime dependencies are `.env.local` (0600), `data/`, `Android/runtime/`, `Android/logs/`, and `node_modules/` (private directories).
The data directory includes SQLite/WAL/SHM, certificates, checkpoints, health state, and existing backups. None are Git integration inputs.
Do not copy a live SQLite file in isolation or replace its WAL/SHM.

## Compatibility review
- Three-way merge of the two reviewed production-only commits into current main is conflict-free.
- Relative to main, implementation changes are the existing onboarding and supervisor changes only; Web routes/components, Auth, Spam policy library, dependency files, and migration files are unchanged.
- Relative to production, `lib/storage/`, SQLite migrations, outbox, provider adapters, circuit/retry/DLQ logic, projection/snapshot processing and restored Worker/Supervisor implementations are unchanged.
- Bot runtime package specifications are unchanged. Only the existing main Next.js/eslint-config-next 16.3.8 updates and peer lockfile keys differ from production.
- Onboarding remains only in `guildCreate`, after the blocked-guild check. Joined-before-start Guilds are skipped; no ready-time tutorial broadcast.
- No new Bot-required environment values. Mandatory Discord names remain `NUVILOVIEW_CLIENT_ID` and `NUVILOVIEW_BOT_TOKEN`; cloud policy requires existing `DATABASE_URL`.
- Existing Local-First/SQLite/multi-provider flags and paths are reused unchanged. Supabase/Turso secrets stay in the current private environment file.
- Web-only Google/Better Auth configuration remains in Vercel; it is not copied to Termux.
- Migration manifest/checksums are validated locally only. Production's 11 applied migrations are not executed or reverted.

## Release and cutover contract
Prepare an immutable release worktree separately from the running production directory.
Preserve the original checkout, dependencies, environment, data, state, logs and backups as rollback assets.
Use the existing Bot-only runner with shared runtime lock/PID paths and the existing environment file. Point the release data path to the same storage, so the unchanged Worker continues processing the same outbox.
Stop only the verified Bot runner gracefully; ensure no live Bot remains before launching the release. Do not clear a live lock or use broad process termination.
Worker and Supervisor stay on their current, byte-identical implementation and are not restarted.
If the candidate fails, stop only its Bot runner and relaunch the preserved previous runner against the same data.

Global and per-Guild commands are currently bulk-synchronized on Bot ready. Before cutover compare all live command name/type pairs with the candidate definitions; stop if any existing command would disappear. `spamprotection` is an extended, Guild-scoped command (not global). Command removal is not authorized.
Use the previously designated test Guild only. Snapshot its policy first, use authorized UI/API commands for temporary changes/reset, retain audit records, then restore the original effective policy.
Never generate spam or induce timeout actions.

## Validation and CI
Run onboarding, supervisor diagnostics/recovery, Spam, Auth, runtime/storage regression, full tests, syntax, lint, TypeScript, build, migration validation and secret scan.
Use an empty ignored local environment fixture only for Backup DryRun; build uses CI-only localhost placeholders, never production secrets.
GitHub CI currently triggers on pull requests and pushes to main only. Run the local checks first, then open a draft PR to obtain hosted CI; mark ready/merge only after all checks pass.
No Web redeploy is needed when Web source and dependency files are unchanged.
Actual OAuth login completion and authenticated UI smoke must be reported separately from unauthenticated route checks.

## Pre-PR measured checks
- Full tests: 549 PASS / 9 SKIP / 0 FAIL. Focused Auth/Spam/Onboarding/Supervisor/runtime tests: 139 PASS / 6 SKIP / 0 FAIL.
- TypeScript and Next.js 16.3.8 production build: PASS using CI-only localhost configuration.
- Syntax: 175 modules PASS. Migration manifest: 11 checksums PASS; Auth migration checksum PASS (validation only).
- Secret scan and diff whitespace check: PASS. Lint: 0 errors / 8 pre-existing warnings.
- Production dependency audit: Critical 0; existing High 2, Moderate 1, Low 1. No dependency changes in this integration.
- Discord REST read-only inventory: 5 global commands and all 15 Guilds inspected; 0 existing command name/type pairs would be removed by the candidate. No Guild had spamprotection registered at inspection.
- Vercel project metadata: nuviloview-oem has no Git integration, so PR/merge will not start an automatic Web deployment.
- Current browser has no authenticated NuviloView session. Actual OAuth and authenticated Guild smoke remain pending, not reported as passed.

## Complete file-level reconciliation
Status is production → pre-integration main.

| Status | Path | Integration decision |
|---|---|---|
| M | `.env.example` | Retain current main implementation |
| M | `.github/workflows/ci.yml` | Retain current main implementation |
| M | `Android/run-sync-worker-forever.sh` | Restore exact reviewed production implementation |
| M | `Android/status-nuviloview.sh` | Restore exact reviewed production implementation |
| A | `app/account/layout.tsx` | Retain current main implementation |
| A | `app/account/page.tsx` | Retain current main implementation |
| A | `app/api/account-connections/route.ts` | Retain current main implementation |
| A | `app/api/account-profile/route.ts` | Retain current main implementation |
| M | `app/api/analytics/community/route.ts` | Retain current main implementation |
| A | `app/api/auth-provider-status/route.ts` | Retain current main implementation |
| A | `app/api/guilds/[guildId]/security/spam-policy/route.ts` | Retain current main implementation |
| M | `app/auth-error/page.tsx` | Retain current main implementation |
| M | `app/backend/status/route.ts` | Retain current main implementation |
| M | `app/dashboard/page.tsx` | Retain current main implementation |
| A | `app/dashboard/security/spam/page.tsx` | Retain current main implementation |
| M | `app/privacy/page.tsx` | Retain current main implementation |
| A | `app/pro/layout.tsx` | Retain current main implementation |
| A | `app/pro/page.tsx` | Retain current main implementation |
| M | `app/robots.ts` | Retain current main implementation |
| M | `app/settings/page.tsx` | Retain current main implementation |
| M | `app/terms/page.tsx` | Retain current main implementation |
| A | `components/account-connections.tsx` | Retain current main implementation |
| A | `components/account-display-identity.tsx` | Retain current main implementation |
| A | `components/account-logout.tsx` | Retain current main implementation |
| A | `components/auth-error-discord-button.tsx` | Retain current main implementation |
| M | `components/community-analytics-dashboard.tsx` | Retain current main implementation |
| A | `components/google-icon.tsx` | Retain current main implementation |
| A | `components/guild-spam-policy-panel.tsx` | Retain current main implementation |
| M | `components/hero-section.tsx` | Retain current main implementation |
| M | `components/login-button.tsx` | Retain current main implementation |
| A | `components/profile-avatar.tsx` | Retain current main implementation |
| M | `components/projection-read-notice.tsx` | Retain current main implementation |
| M | `components/site-header.tsx` | Retain current main implementation |
| A | `components/use-display-identity.ts` | Retain current main implementation |
| M | `discord-bot.mjs` | Merge main Spam commands/policy with existing production onboarding |
| A | `docs/account-provider-management.md` | Retain current main implementation |
| A | `docs/auth-provider-identity-phase-05d.md` | Retain current main implementation |
| A | `docs/auth-provider-identity-phase-05e-logout.md` | Retain current main implementation |
| A | `docs/auth-provider-identity-phase-05e.md` | Retain current main implementation |
| A | `docs/google-oauth-phase-0.5.md` | Retain current main implementation |
| A | `docs/guild-spam-policy.md` | Retain current main implementation |
| D | `docs/worker-recovery-phase1.md` | Restore exact reviewed production implementation |
| A | `lib/auth-provider-config.ts` | Retain current main implementation |
| A | `lib/auth-provider-identity.ts` | Retain current main implementation |
| A | `lib/auth-redirect.ts` | Retain current main implementation |
| A | `lib/auth-unlink-guard.ts` | Retain current main implementation |
| M | `lib/auth.ts` | Retain current main implementation |
| A | `lib/channel-metadata.ts` | Retain current main implementation |
| M | `lib/db/schema.ts` | Retain current main implementation |
| M | `lib/discord.ts` | Retain current main implementation |
| A | `lib/display-identity.ts` | Retain current main implementation |
| D | `lib/guild-onboarding.mjs` | Restore exact reviewed production implementation |
| A | `lib/guild-spam-policy-request-guard.d.mts` | Retain current main implementation |
| A | `lib/guild-spam-policy-request-guard.mjs` | Retain current main implementation |
| A | `lib/guild-spam-policy.d.mts` | Retain current main implementation |
| A | `lib/guild-spam-policy.mjs` | Retain current main implementation |
| A | `lib/insight-presentation.d.mts` | Retain current main implementation |
| A | `lib/insight-presentation.mjs` | Retain current main implementation |
| M | `lib/projection-analytics.ts` | Retain current main implementation |
| A | `lib/provider-label.ts` | Retain current main implementation |
| M | `lib/spam-protection.mjs` | Retain current main implementation |
| D | `lib/sync/worker-diagnostics.mjs` | Restore exact reviewed production implementation |
| D | `lib/sync/worker-supervisor.mjs` | Restore exact reviewed production implementation |
| M | `next.config.mjs` | Retain current main implementation |
| M | `package.json` | Retain current main implementation |
| M | `pnpm-lock.yaml` | Retain current main implementation |
| M | `pnpm-workspace.yaml` | Retain current main implementation |
| A | `scripts/auth-migrations/20260906-provider-identity-unique.sql` | Retain current main implementation |
| A | `scripts/auth-migrations/duplicate-audit.sql` | Retain current main implementation |
| A | `scripts/auth-migrations/loader.mjs` | Retain current main implementation |
| A | `scripts/auth-migrations/manifest.json` | Retain current main implementation |
| A | `scripts/migrate-auth-identity.mjs` | Retain current main implementation |
| A | `scripts/migrations/20260930-guild-spam-policy.sql` | Retain current main implementation |
| A | `scripts/migrations/20261001-guild-spam-protection-controls.sql` | Retain current main implementation |
| M | `scripts/migrations/manifest.json` | Retain current main implementation |
| M | `scripts/run-sync-worker.mjs` | Restore exact reviewed production implementation |
| D | `scripts/supervise-sync-worker.mjs` | Restore exact reviewed production implementation |
| A | `scripts/validate-auth-migrations.mjs` | Retain current main implementation |
| M | `scripts/validate-migrations.mjs` | Retain current main implementation |
| D | `scripts/worker-crash-preload.mjs` | Restore exact reviewed production implementation |
| A | `tests/account-logout.test.mjs` | Retain current main implementation |
| A | `tests/account-provider-management.test.mjs` | Retain current main implementation |
| A | `tests/auth-account-pro-shell.test.mjs` | Retain current main implementation |
| A | `tests/auth-discord-first-onboarding.test.mjs` | Retain current main implementation |
| A | `tests/auth-phase-05-security.test.mjs` | Retain current main implementation |
| A | `tests/auth-provider-identity-postgres.test.mjs` | Retain current main implementation |
| A | `tests/auth-provider-identity.test.mjs` | Retain current main implementation |
| M | `tests/dashboard-data-connection.test.mjs` | Retain current main implementation |
| D | `tests/guild-onboarding.test.mjs` | Restore exact reviewed production implementation |
| A | `tests/guild-spam-policy-ui-race.test.mjs` | Retain current main implementation |
| A | `tests/guild-spam-policy.test.mjs` | Retain current main implementation |
| A | `tests/guild-spam-protection-controls.test.mjs` | Retain current main implementation |
| A | `tests/helpers/auth-identity-scenarios.mjs` | Retain current main implementation |
| A | `tests/insight-presentation.test.mjs` | Retain current main implementation |
| A | `tests/login-button-style.test.mjs` | Retain current main implementation |
| M | `tests/message-history-import-v2-ui.test.mjs` | Retain current main implementation |
| M | `tests/projection-analytics-v1.test.mjs` | Retain current main implementation |
| A | `tests/provider-label.test.mjs` | Retain current main implementation |
| M | `tests/spam-protection.test.mjs` | Retain current main implementation |
| M | `tests/web-auth-storage.test.mjs` | Retain current main implementation |
| D | `tests/worker-supervisor.test.mjs` | Restore exact reviewed production implementation |
