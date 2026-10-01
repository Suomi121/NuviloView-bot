# Phase 0.5e — Logout and real OAuth continuation

Reviewed: 2026-09-07 (JST). NuviloView Preview only.

**Complete Phase 0.5e: NO-GO — real authorized-Guild verification and the Production Auth DB destination remain unconfirmed.**
This is an evidence gap, not a demonstrated identity-uniqueness or logout defect.
**Production migration: NOT READY. Production deployment/recommendation: NO.**
**Production changes performed: NONE.**

## Scope and preserved work

Branch: `fix/provider-identity-concurrency-phase05d`.
Identity-fix checkpoint: `f5d20c68811de12cb7ad20854060ab3ec33a76a7`.
The existing Preview ownership migration and its successful duplicate INSERT
rejection tests were reused, not reapplied. No Production SQL was executed.

The Settings page already had the official Better Auth logout implementation.
It was extracted into a single shared component and mounted on Account and Settings.
No provider-specific logout, cookie manipulation, account unlink, new logout route,
permission relaxation, schema change or dependency upgrade was introduced.

Changed application files:

- `components/account-logout.tsx` — shared `signOut`, in-flight guard, disabled/busy
  button, Japanese/English safe failure message, successful public-document replacement.
- `app/account/page.tsx` — mounts the component; existing server session guard preserved.
- `app/settings/page.tsx` — reuses the same component; other settings unchanged.

Related tests: `tests/account-logout.test.mjs`,
`tests/auth-phase-05-security.test.mjs`,
`tests/helpers/auth-identity-scenarios.mjs`,
`tests/message-history-import-v2-ui.test.mjs`.
The two existing source-level Settings assertions now follow the shared component
instead of requiring the old inline handler. They still assert the official helper
and existing account/theme/import controls.

## Preview deployment

- Current Preview: `dpl_2szuLkoNXdJTjyaiqFhQPi2psbmr`, READY, Preview target.
- Previous Preview: `dpl_DoaeNc4w8KJUYEQr41efeXhkBrGo`.
- Existing canary OAuth alias points to the new Preview; Production alias unchanged.
- `/account` displays the formal Logout button; Google and Discord show Connected.
- Preview Auth DB remains **nuviloview-auth-preview**, isolated Free/Tokyo project.
- No new bypass secret, Preview credential change, migration or account cleanup.

## Anonymous identity and session evidence

| Observation | Result |
| --- | --- |
| Preview users | 2 |
| Provider identities | 4 |
| Linked Google+Discord users | 2 |
| Duplicate identity groups | 0 |
| Multiple-owner identity groups | 0 |
| Required UNIQUE constraint | 1, present |
| Sessions after tested login | 2 total; 1 belongs to the tested user |
| Sessions immediately after formal tested logout | 1 total; 0 belongs to the tested user |
| Existing other user's session | Preserved |
| Same Better Auth user for tested Google/Discord logins | YES |

The earlier checkpoint recorded one user and two identities. Read-only creation-time
inspection established that the second user and its Google/Discord identities were
created before the new Preview deployment and before the real re-login matrix
recorded here. No claim is made about who performed those earlier actions.
The tested Google and Discord account updates resolve to that same pre-existing
owner. Re-login did not add users or identities. No IDs, emails, tokens or credentials
were included in the queries' displayed results or this report.

## Real browser results

| Case | Result and evidence boundary |
| --- | --- |
| Google login | PASS: actual Google chooser, callback, protected Account page |
| Discord login | PASS: actual Discord callback, Dashboard, protected Account page |
| Existing linked account | PASS: both Connected, same DB owner, no identity duplication |
| Formal Better Auth logout | PASS: public landing, sign-out HTTP 200, tested owner's server session count 0 |
| `/account` after logout | PASS: server redirects to public landing; observed HTTP 307 |
| Google → Logout → Google | PASS for authentication/session/identity preservation |
| Discord → Logout → Discord | PASS for authentication/session/identity preservation |
| Google → Logout → Discord | PASS for authentication/session/identity preservation |
| Discord → Logout → Google | PASS for authentication/session/identity preservation |
| Guild selector | Loads, but reports no managed Guilds for this linked Discord account |
| Guild-list API | Observed HTTP 200; no authorized-Guild data established |
| Authorized Guild analytics / private Guild API | NOT REAL-TESTED: no managed Guild available |
| Unauthorized real Guild | NOT REAL-TESTED: no approved target established; isolated denial tests PASS |
| Google-only real OAuth isolation | NOT TESTED: no separate test account selected |
| Real alternate-user identity collision | NOT TESTED; prior isolated actual-Auth and Preview constraint tests preserved |

Back after logout returned the Dashboard shell with the generic unauthenticated
user label, no selected Guild and empty metrics. The protected Account page still
denied access. This is not claimed as complete Back/cache private-data verification:
no authorized Guild was available to establish a private-data baseline, and direct
browser navigation to the Guild API was blocked by the browser client. No browser
restriction or session boundary was bypassed. The server's rejection of old session
cookies at Guild and snapshot APIs is covered by the isolated actual-Better-Auth
tests below, not mislabeled as a real browser private-Guild test.

One navigation attempt was interrupted by the verification driver matching a public
demo heading before OAuth completed. It was not counted as a successful login.
Completion was subsequently verified on the real protected Account page and by
the callback/session evidence. No product authentication exception was suppressed.

The no-managed-Guild case cannot demonstrate stale-permission behavior for a Guild
that this account actually administers. That part of the requested matrix remains open.

## Validation evidence (reused after the final read-only continuation)

| Check | Result |
| --- | --- |
| Target Auth/Logout tests | 11/11 PASS |
| Isolated PostgreSQL actual-Auth suite | 33/33 PASS, 0 SKIP |
| Google and Discord x2/x10/x100 concurrency | PASS; exactly one success/owner/identity and zero duplicates |
| Google-only, Discord-only and linked logout | PASS; replayed old cookie resolves to no session |
| Old-cookie Guild and snapshot API requests | HTTP 401 for each tested session type |
| Same/cross-provider isolated re-login | PASS, same owner |
| Full suite | 449 total: 440 PASS, 9 SKIP, 0 FAIL |
| Build / standalone TypeScript | PASS |
| Syntax | 159 modules PASS |
| Lint | 0 errors, 8 existing warnings |
| Migration validation | 9 immutable legacy checksums + 1 Auth checksum PASS |
| Static schema drift | PASS |
| Secret scan / changed-file review | PASS; no credentials or DB files staged |
| Critical production dependency audit | No known vulnerabilities |
| Diff whitespace check | PASS |

Tests use the actual repository Better Auth handler and isolated PostgreSQL; only
external provider responses are synthetic. Live Cloud stress was not performed.
The disposable PostgreSQL server was stopped gracefully. Full-suite skips requiring
external environments remain explicit; Auth PostgreSQL was tested separately.
No code changes were made during the final read-only continuation, so full tests,
build, migration and concurrency were not rerun just to repeat completed evidence.

## Production destination audit

| Field | Result |
| --- | --- |
| Auth provider | Supabase, from verified Production provider configuration |
| Auth project name | UNKNOWN |
| Database name | UNKNOWN |
| Duplicate identity groups | UNKNOWN; SELECT audit not executed |
| Production deployment | `dpl_CxTXYMep1A2Ua2Zyk1ouN1Dxqd4E`, READY, unchanged |
| Production public alias | Still assigned to the same deployment |
| Production Auth environment update metadata | Matches prior baseline |

The Production Auth connection entry is a sensitive Vercel setting. Read-only API
metadata has no integration resource ID or custom comment identifying its destination.
The normal environment-read path also reports that sensitive Production values cannot
be pulled. Local environment fallback is not accepted as proof of Production's target.
No old canary hostname, similarly named project, or local configuration was guessed
as the Production Auth database. No secret was printed or rotated.

No Production INSERT, UPDATE, DELETE, DDL, migration, deploy, alias/environment
change, Bot/Worker restart, Termux update or main merge was performed.

## Separate gates

| Gate | Verdict |
| --- | --- |
| Identity concurrency fix | GO |
| Logout foundation | GO; real server invalidation plus isolated protected-API denial |
| Complete Preview OAuth/Guild foundation | NO-GO pending authorized-Guild and private Back/cache evidence |
| Production migration readiness | NOT READY |
| Production deployment / recommendation | NO |

## Resume only the remaining checks

1. Obtain a user-selected Discord account with a safely testable managed Guild.
   Verify authorized-Guild read, safe unauthorized-Guild denial, and private-data
   Back/cache boundaries. Do not repeat the completed four login/logout permutations.
2. Obtain trusted identification of the exact Production Auth project/database;
   then run only the anonymous duplicate-group SELECT. Do not apply the migration.
3. A separate Google-only account is optional; otherwise keep real isolation NOT TESTED.

No existing identity should be unlinked/deleted to manufacture these prerequisites.
Application rollback, if required, is limited to the previous Preview alias target;
retain the successfully applied ownership UNIQUE constraint. Production requires
separate explicit approval and remains untouched.
