# Production execution log — 2026-08-21

This log records production release operations without secret values. Timestamps use JST unless stated otherwise.

## Preflight

| Operation | Target | Started at | Completed at | Result | Safe summary | Verification |
|---|---|---:|---:|---|---|---|
| Global preflight | Source, Git, CI inputs, Neon schema, Windows/Android runtime, F/G backup, Vercel inventory | 2026-08-21 20:00 | 2026-08-21 20:27 | SUCCESS | No production mutation. Android and Windows were both running with singleton disabled; this blocks unsafe all-host promotion. | 243 tests; TypeScript, lint, syntax, build, migration validation, secret scan; F/G restore verification |
| Dependency remediation | Locked Web/Bot dependencies | 2026-08-21 20:27 | 2026-08-21 20:31 | SUCCESS | Next.js and eslint-config-next were updated to 16.3.2 and CI was aligned with the tracked pnpm lockfile. No production process changed. | 243 tests, build, TypeScript, secret scan and audit passed; 0 lint errors / 12 warnings; 0 known production dependency vulnerabilities |
| First PR CI attempt | GitHub Actions run 32477683552 | 2026-08-21 20:32 | 2026-08-21 20:33 | FAILED | Linux checkout exposed two migration checksums that depended on Windows CRLF. Failure was isolated before merge or production mutation. | Failed only at migration manifest validation |
| Cross-platform migration checksum remediation | Migration validation and runner | 2026-08-21 20:33 | 2026-08-21 20:35 | SUCCESS | SQL checksum input is normalized to LF so Windows and Linux validate the same immutable content. | Local and Linux CI migration validation passed |
| Second PR CI attempt | GitHub Actions run 32477859865 | 2026-08-21 20:35 | 2026-08-21 20:36 | FAILED | The tracked pnpm lockfile was correct, but the audit script still invoked npm audit, which requires an ignored npm lockfile. No production mutation occurred. | All preceding CI steps passed; failure isolated to audit command |
| pnpm audit remediation | CI dependency audit | 2026-08-21 20:36 | 2026-08-21 20:38 | SUCCESS | The audit command now uses the committed pnpm lockfile and nanoid is pinned to its patched 3.x release. | Local audit and GitHub Actions run 32478092815 passed with no known production dependency vulnerabilities |
| First fresh backup attempt | Local staging and F/G destinations | 2026-08-21 20:40 | 2026-08-21 20:40 | FAILED_SAFE | Source screening rejected the CI workflow's explicit two-character test-only database credential as a potential production secret. Artifact generation and destination copy did not start. | No DB, F/G, Web or Bot mutation; existing verified backup remained intact |
| Backup scanner false-positive remediation | Source inventory scanner | 2026-08-21 20:41 | 2026-08-21 20:45 | SUCCESS | Only explicitly labelled test/CI placeholder database credentials are exempted; real credential-bearing database URLs remain rejected. | 5 backup tests passed; 446 included files rescanned with zero secret findings |
| Fresh production backup | Backup set `20260821-204609-7c9505a6` | 2026-08-21 20:46 | 2026-08-21 20:47 | SUCCESS | One-shot generation completed once with ContainsSecrets false. The runner was not enabled. Backup encryption remains unavailable in the current configuration. | F and G independently verified 4 files, 446 source entries and a restorable PostgreSQL dump |

## Production operations

| Operation | Target | Started at | Completed at | Result | Safe summary | Verification |
|---|---|---:|---:|---|---|---|
| GitHub PR and merge | `feat/release-readiness-20260821` to `main` | 2026-08-21 20:31 | 2026-08-21 20:53 | SUCCESS | PR #2 was merged normally after the additive DB migration. Force push and direct main push were not used. | Head `a4edf81`; CI run 32479060732 passed; merge `c94fe86` |
| Production migration | Neon PostgreSQL | 2026-08-21 20:48 | 2026-08-21 20:50 | SUCCESS | Five existing schema groups were adopted into the journal; the journal, nine retention indexes and Message History Import v2 schema were applied transactionally. No DROP, TRUNCATE or row deletion occurred. | All 8 migrations report applied with valid checksums; 24 related indexes, 2 new tables and required columns are present |
| Production Web deploy | Vercel `nuviloview-oem` | 2026-08-21 20:54 | 2026-08-21 21:09 | SUCCESS | The backward-compatible Web/API release, Message History Import v2 flag and Bearer monitor support were deployed in dependency order. Dangerous feature flags stayed off. | Final deployment `dpl_8G9fY2Jfa4vfp9DBWtprXDnKMmco` Ready; landing, Privacy and sitemap 200; protected APIs reject unauthenticated callers |
| Production Bot deploy | Windows Bot host; Android standby | 2026-08-21 20:56 | 2026-08-21 21:01 | SUCCESS | Android was gracefully stopped before the Windows runner was restarted with the latest Bot and Message History Import v2. Only Windows remains active. | 12 Guilds, fresh heartbeat, one Bot process; Android PID absent; a new message was stored with source `live` |
| Message History Import v2 | Web, Bot and Neon | 2026-08-21 20:58 | 2026-08-21 21:01 | SUCCESS | The feature was enabled only after schema, Web and Bot readiness. Existing messages remain `existing`; no Analytics message was deleted. | 24,688 existing rows and a new live row observed; legacy job safely classified `LEGACY_IMPORT_STALLED` |
| Distributed singleton | Windows and Android/Termux | 2026-08-21 21:01 | 2026-08-21 21:03 | BLOCKED_SAFE | Production enablement was not attempted because the paired Android Agent cannot safely receive a fixed host ID and singleton environment remotely. Windows remains the sole running Bot. | Isolated real-DB rehearsal passed 8/8; production service key untouched; no test rows remain |
| Production failover | Android/Termux and Windows | 2026-08-21 21:01 | 2026-08-21 21:03 | SKIPPED_SAFETY_GATE | Real-host failover would violate the all-host configuration prerequisite and could create split brain. | Android stopped; Windows healthy; no production lease created |
| External monitoring | GitHub Actions and Vercel monitor API | 2026-08-21 21:03 | 2026-08-21 21:09 | SUCCESS | A bounded five-minute independent check uses a Bearer secret and returns only `ok` or `down`. The token is absent from URLs and logs. | PR #3 CI passed; manual workflow run 32480518057 passed end to end |
| Security auto containment | Per-Guild Security v1 policy | 2026-08-21 21:09 | 2026-08-21 21:10 | SKIPPED_SAFETY_GATE | All 13 policies remain Shadow because four Guilds lack permissions and no trusted actors are registered. | Auto containment/restore 0; 7-day incidents: Normal 4, Suspicious 2, High/Critical 0 |
| Guild Reset | Global and per-Guild flags | 2026-08-21 21:10 | 2026-08-21 21:10 | SKIPPED_SAFETY_GATE | Production enablement remains blocked by local unencrypted reset backups and no disposable-Guild restoration rehearsal. | Settings, executions, backups and active requests all 0 |
| Monitor secret rotation | Vercel and GitHub Actions | 2026-08-21 21:04 | 2026-08-21 21:09 | SUCCESS | Only the unusable monitor credential was replaced and synchronized in memory; no value was logged or written to Git. | Bearer-authenticated workflow run completed successfully; token leak scan passed |
| DROP / TRUNCATE | Production PostgreSQL | 2026-08-21 20:48 | 2026-08-21 20:50 | SKIPPED_NOT_REQUIRED | No obsolete object or unsafe staging data required destructive removal. | Managed migrations contain no DROP or TRUNCATE |
| Force/direct push | GitHub `main` | 2026-08-21 20:31 | 2026-08-21 21:08 | SKIPPED_NOT_REQUIRED | Normal feature branches, CI and PR merges succeeded. | No force push and no direct main push used |

## Rollback anchors

- Git: previous known-good `origin/main` was `38f2125d09af4cb5bb21a6a09ee397833f63c0e5` at preflight.
- Database: verified backup set `20260821-204609-7c9505a6` exists on both F and G; secret scan and restore verification passed. The earlier `20260821-183211-e045480e` set is also retained.
- Runtime: disable new feature flags first, then run exactly one known-good Bot host.
- Web: promote the previous known-good immutable Vercel deployment `dpl_G76DqWJmqdrD7eRL5yGKRNzMH59q`.

No secret values, Bot tokens, database credentials, OAuth secrets, IP addresses from user requests, or raw environment contents are recorded here.
