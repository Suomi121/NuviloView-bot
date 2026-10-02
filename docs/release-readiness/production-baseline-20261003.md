# Production baseline reconciliation — 2026-10-03 JST

## Fresh read-only evidence

- GitHub `origin/main`: `0cc2f73010f7dfc2efb004367642cdac371bdb91`.
- Production alias: `nuviloview-oem.vercel.app`; deployment `dpl_J6mGZMXwGQyK9xkNX2EDc9g1DxE4`, READY.
- Deployment metadata `nuviloviewReleaseSha`: `79b0bd869b40527d2987e04ddc7575eec3a841be`. CLI provenance is operator-supplied, not a cryptographic artifact attestation.
- Exact Vercel binding: project `nuviloview-oem` / `prj_PO2v7GSIuseAEEeq7vhBa71Upn4X`, team `metaru432-5735s-projects` / `team_IsqvYZzWJ3S01iV1PmKzC7BG`. Git integration absent.
- Missing from main: `9ec1efc` (rate-limit UX) and `79b0bd8` (desktop/mobile security link), 12 changed files. Both reviewed and fast-forwarded onto the reconciliation branch; no unrelated feature restored.
- Bot PID 13779, runner 13581: `~/NuviloView-release-0cc2f73`, HEAD `0cc2f73`, tracked files clean, one Bot, Discord ready, NORMAL.
- Worker PID 23155, Node supervisor 23146, shell runner 22946: `~/NuviloView-bot`, HEAD `413a03d`, tracked files clean, HEALTHY. Worker/runner process start identity unchanged since cutover.
- `413a03d` is an ancestor of main, zero production-only commits, 28 commits in the other direction. Storage/sync libraries, Worker/preload/supervisor and shell runner diff against main is empty.
- Supabase/Turso healthy, circuits closed, pending/processing/retry/DLQ all zero. Optional Neon sync disabled. No queue operations performed.
- Existing environment checksum and SQLite inode unchanged. No database migration/query/mutation needed for this reconciliation.

## Feature inventory

“Present” denotes code/deployment evidence, not a claim of fresh real OAuth or mutation smoke.

| Feature | Production | Starting main | Tests | Reconciliation |
|---|---|---|---|---|
| Landing / Dashboard / Analytics | Present | Present | dashboard/projection tests | Retained |
| Google / Discord OAuth | Present | Present | auth-provider, security, Discord-first | Retained; real login not repeated |
| Account / explicit linking / unlink guards | Present | Present | account-provider-management, identity PostgreSQL | Retained |
| Discord Guild authorization / Google-only denial | Present | Present | auth-phase-05-security, Spam controls | Retained |
| Spam UI / API / race guard / audit | Present | Present | guild-spam-policy, controls, UI race | Retained |
| Rate-limit countdown / sanitized auth error | Present | Missing | social-login-rate-limit | Integrated 9ec1efc |
| Desktop / mobile gradient security link | Present | Missing | security-navigation-link | Integrated 79b0bd8 |
| New-Guild onboarding | Present | Present | guild-onboarding | Retained; no tutorial sent |
| Worker recovery / diagnostics | Present | Present | worker-supervisor | Byte-identical implementation |
| /spamprotection / legacy commands | Present | Present | guild-spam-protection-controls | No registration/change |
| Local-first / SQLite WAL | Present | Present | local-storage/runtime integration | Shared existing data preserved |
| Multi-DB / queue / retry / circuit / DLQ | Present | Present | multi-db-sync/sync-worker | Byte-identical Worker sources |
| Projection / monitoring / security | Present | Present | projection/runtime-monitor/spam tests | Retained |
| Pro shell / developer tools / history / settings / privacy | Source present | Present | existing full suite | No additional feature enabled |

## Runtime dependencies and startup

The Bot uses tracked `Android/run-bot-forever.sh`; Worker uses tracked `Android/run-sync-worker-forever.sh` → `scripts/supervise-sync-worker.mjs` → preload + `scripts/run-sync-worker.mjs`.
The host boot wrapper is configuration outside Git, not a missing feature. Its SHA256 is `ccc5d3a1e5225d9a94a246b02a942b591227c66e2acb9323b0bb01c2ee89fb03`, matched against the retained cutover record. Reproducible shape:

```sh
#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT=/data/data/com.termux/files/home/NuviloView-release-0cc2f73
export NUVILOVIEW_ENV_FILE=/data/data/com.termux/files/home/NuviloView-bot/.env.local
export NUVILOVIEW_ANDROID_RUNTIME_DIR=/data/data/com.termux/files/home/NuviloView-bot/Android/runtime
export NUVILOVIEW_ANDROID_LOG_DIR=/data/data/com.termux/files/home/NuviloView-bot/Android/logs
if [[ ! -x "$PROJECT_ROOT/Android/boot-start.sh" ]]; then exit 1; fi
exec "$PROJECT_ROOT/Android/boot-start.sh" >> "$NUVILOVIEW_ANDROID_LOG_DIR/termux-boot.log" 2>&1
```

Host also has `20-botcenter-agent.sh`; unrelated host-management service, not imported into NuviloView. Release symlinks `data`, `Android/runtime`, `Android/logs` appear as untracked names (directory ignore rules do not hide symlinks). They are shared runtime state, NEVER add/clean them. `.env.local` is a symlink to the preserved private file. `node_modules` is installed runtime dependency material, not source.

## Environment metadata

Live metadata gate passes. No values are stored here. Production has `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `WEB_AUTH_DB_PROVIDER`, `WEB_AUTH_SUPABASE_DATABASE_URL`, `WEB_AUTH_SUPABASE_CA_CERT`, Discord credentials (`DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`), Google credentials (`NUVILOVIEW_GOOGLE_CLIENT_ID`/`NUVILOVIEW_GOOGLE_CLIENT_SECRET`). Preview uses NUVILOVIEW Discord aliases and its own scoped Auth entries. `DATABASE_URL` exists Production-only.

Both scopes contain Supabase/Turso connection names and multi-DB/read-router/snapshot flags. Metadata does NOT prove Preview DB isolation; do not perform authenticated DB-backed Preview smoke until isolation is checked. `GEMINI_API_KEY` and `AI_GATEWAY_API_KEY` are Preview-only; AI feature is outside this release. Production contains monitor, audit-signing, owner/developer-ID, Guild reset, retention and support-mail settings. No environment changes made.

Termux uses existing `NUVILOVIEW_CLIENT_ID`, `NUVILOVIEW_BOT_TOKEN`, `DATABASE_URL`, audit/owner IDs, `LOCAL_*`, `LOCAL_FIRST_*`, `EVENT_LOCAL_FIRST_*`, `SYNC_*`, `MULTI_DB_SYNC_ENABLED`, Supabase/Turso credentials, analytics/projection and history-import flags. Names only were inspected. No new runtime variables required.

## Boundaries

Source contract + behavioral CI and real runtime smoke are separate gates. No fresh Google/Discord login, Guild mutation, automated punishment, or slash interaction is claimed. Historical deployments without source provenance cannot be proven byte-for-byte identical; current release metadata and current serving HTML are corroborating evidence. No reason to redeploy Production: integrated application tree is the already-running Web source; additions only harden CI/tests/docs.
