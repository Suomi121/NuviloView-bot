# CLI production release gate

Do not deploy a feature worktree or uncommitted local directory. No automatic Git integration or auto-deploy is introduced.

## Required sequence

1. `git fetch origin`; record `git rev-parse origin/main`. Require all GitHub CI checks for that exact SHA to pass (including Auth PostgreSQL races). No bypass on failed/pending CI.
2. Create a new detached worktree from that SHA. `git status --porcelain` must be empty. Confirm `origin` is `https://github.com/Suomi121/NuviloView-bot.git`. Never deploy from system32 or a directory holding old local patches.
3. Install pinned pnpm/Node24 dependencies with `pnpm install --frozen-lockfile`. Run `node scripts/production-contract.mjs`, full tests, TypeScript, lint, syntax, migration manifest/checksum, token scan, dependency audit and build. Bot has no transpilation build: syntax plus isolated runtime/supervisor tests are its build/startup gate. Never start a real Bot as a build test.
4. If Backup DryRun needs a local environment file, use an empty ignored local-only fixture ONLY when none exists. Delete only the created fixture after tests. Never copy Production credentials to make tests pass.
5. Link ONLY existing `nuviloview-oem`, scope `metaru432-5735s-projects`. Verify `.vercel/project.json` project ID `prj_PO2v7GSIuseAEEeq7vhBa71Upn4X`, org ID `team_IsqvYZzWJ3S01iV1PmKzC7BG`. Do not enable Git integration/create projects. Do not download env values. Some CLI link versions write local env/ignore files: inspect and remove only newly created generated files, never an existing secret.
6. Read Vercel env metadata using authenticated CLI API in memory; project the response to `{key,target,gitBranch}` ONLY. Pipe this sanitized array into `node scripts/production-contract.mjs --env-metadata-stdin`. Do not print/store the raw API response, values or encrypted values. Record only name/scope and PASS. Source CI does not have Production credentials: this live metadata gate is mandatory separately before deploy.
7. Create Preview with release SHA metadata. Use `vercel curl` for protected previews; do not disable protection. Build and unauthenticated route/provider/button checks must pass. Authenticated OAuth/Guild smoke requires verified isolated configuration and an appropriate test identity; do not assume Preview means isolated. Do not invent an OAuth PASS from an HTTP200.
8. Compare current Production source SHA to candidate across application/config/dependency files AND middleware/proxy files. If only tests/docs/CI changed, no Production deploy. For Web changes: record existing Deployment ID + release SHA, then after explicit approval run CLI production deploy from the same clean source, with `--scope metaru432-5735s-projects --meta nuviloviewReleaseSha=<verified-main-SHA>`. Do not promote Preview blindly: it may carry Preview credentials.
9. Require READY and official alias mapping. Record actual Deployment ID, source SHA, build result, sanitized error scan, route/API results. Verify Google/Discord availability, account, dashboard, Spam API, and both security navigation entries. Real OAuth success is separately tested/manual, never inferred.
10. Bot changes: compare running process cwd/arguments/HEAD and tracked diff, not HEAD alone. Keep immutable prior checkout and shared env/SQLite+WAL/state/queues/logs/backups. Check Worker source compatibility. Prepare a separate release directory; use established singleton/graceful cutover only if needed. Never restart unchanged Worker/Supervisor. Do not synchronize slash commands if that removes existing names. Restore any approved smoke Guild setting; preserve audit.
11. Never rerun migrations as part of build/deploy. Production migration execution requires its separate approval/backup/restore gate.

## Rollback

Record known-good deployment/source and Bot code before any cutover. Check security floor/advisories and current additive schema compatibility first. An old deployment with a vulnerable Next.js version is NOT an acceptable rollback target. Prefer reviewed forward fix when secure compatible rollback is unavailable. Never restore/overwrite live SQLite alone or reset queues. Stop on unexpected runtime regressions.

## Release evidence

Store non-secret date, source SHA, CI URLs/results, Preview Deployment ID/smoke coverage, Production Deployment ID (or unchanged), Bot/Worker source/cwd relationship, env-name/scope result, dependency audit, known gaps. SHA metadata is provenance evidence, not signed attestation. Real OAuth and authorized data paths require separate evidence. Required features cannot be removed by editing the contract without an explicit reviewed retirement decision.
