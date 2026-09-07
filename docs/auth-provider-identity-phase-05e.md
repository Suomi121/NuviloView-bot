# Phase 0.5e — Isolated Preview migration and OAuth checkpoint

Historical checkpoint. For the later shared Logout UI validation and real OAuth
matrix, see [the 2026-09-07 continuation](auth-provider-identity-phase-05e-logout.md).
The successful Preview migration below was not repeated.

Reviewed: 2026-09-06. Scope: NuviloView Web Auth only.

**Result: NO-GO for the complete Phase 0.5e gate; real OAuth account selection is pending.**
**Production migration: NOT READY. Production recommendation: NO.**
**Production changes performed: NONE.**

This report continues Phase 0.5d; it does not repeat or replace the original implementation.
Base: `865286cabb59a98591ef90e88df15d0cf8586dca`.
Branch: `fix/provider-identity-concurrency-phase05d`.

## Preview migration — PASS

Target confirmed in the Supabase console: **nuviloview-auth-preview**, the isolated
Free/Tokyo project created for this canary. The console's `main` database branch is
not the NuviloView Production environment. No Production data was copied.

| Anonymous check | Before | After migration and duplicate test |
| --- | ---: | ---: |
| Users | 1 | 1 |
| Accounts | 2 | 2 |
| Sessions / active sessions | 0 / 0 | 0 / 0 |
| Google + Discord linked users | 1 | 1 |
| Duplicate provider identity groups | 0 | 0 |
| Multiple-owner identity groups | 0 | 0 |
| Required Auth/application tables | 8 | 8 |

Applied the existing checked repository migration:
`scripts/auth-migrations/20260906-provider-identity-unique.sql`.
Normalized checksum: `aeba63ae0114ec3090c5aa0908c6a4b4e1a75cb6919d27737d5c3ff58f45b3c4`.
No new or alternate migration was invented.

Execution used the authenticated SQL editor of the explicitly identified isolated
Preview project. The editor initially retained part of the previous SELECT during
text replacement; that attempt failed with SQL syntax error 42601 before DDL.
The entire editor content was then replaced and copied back for an exact normalized
comparison with the formal migration before execution. The complete formal SQL
succeeded. No statement was weakened or skipped.

Post-application catalog inspection confirmed:

- `account_provider_identity_unique`: PRESENT.
- Exact key: `UNIQUE ("providerId", "accountId")`, not a user-scoped three-column key.
- Validated, non-deferrable, immediate constraint.
- All eight required tables remain present; existing linked account count unchanged.

Actual Preview constraint test: duplicate INSERTs for each of the two already-linked
provider identities were rejected with PostgreSQL `unique_violation` and the exact
ownership constraint name. The test explicitly failed on acceptance or a different
constraint. The outer transaction ended with **ROLLBACK**. No test accounts or
identities were retained; no existing tokens/identity values were emitted.

No cleanup, reset, account deletion or Production SQL was performed.

## Preview deployment — READY

- Previous Preview: `dpl_DefcP4de3KZAJK2YSoFyapMZ5h7i`.
- Fixed Preview: `dpl_DoaeNc4w8KJUYEQr41efeXhkBrGo`.
- Target: Preview (`target: null`), not Production.
- Fixed canary OAuth alias was assigned to the new Preview only.
- Google/Discord Preview credentials and Auth environment metadata remained unchanged.
- Remote Preview build and TypeScript passed.

The deployment used the validated Phase 0.5d working-tree source. Subsequent additions
are this verification document, not application changes. Production alias was not moved.

An unauthenticated `/account` browser visit correctly returned to the landing page,
and the Google login action reached the real Google account chooser. This proves
neither successful OAuth completion nor the full logged-in regression matrix.
No new Vercel bypass secret was created. Unauthenticated shell probes hit Vercel
Protection redirects and are **not counted** as application authorization tests.
Direct browser navigation to the session API was blocked by the browser and was not
worked around or counted as a completed API test.

## Real OAuth matrix — pending user account selection

Several Google accounts are visible in the existing browser session. The user was
asked to select the previously linked account; no account was guessed or unlinked.
Availability of a separately approved Google-only test account is unconfirmed.

| Required real Preview case | Current evidence |
| --- | --- |
| Google login completion / callback / session | NOT TESTED after this deployment; account chooser reached |
| Discord login / guild selector | NOT TESTED after this deployment |
| Existing linked account UI | NOT TESTED; DB linkage preserved |
| Authorized Guild / unauthorized Guild / private API | NOT TESTED after this deployment |
| Google-only real isolation | NOT TESTED; separate test account not selected |
| Real alternate-user identity collision | NOT TESTED |
| Logout / re-login permutations | NOT TESTED after this deployment |
| Browser Back/cache after logout | NOT TESTED |

Earlier successful real logins are not relabeled as post-migration regression tests.
Likewise, the isolated actual-Better-Auth callback tests below do not substitute for
the real Google/Discord consent and callback matrix.

## Isolated concurrency and local validation — PASS

Re-executed once for this phase on Node 24.18.0 / Windows with isolated PostgreSQL
18.4. Tests use the actual repository Auth configuration and Better Auth 1.6.25;
external provider token/profile responses are synthetic. External HTTP attempts: 0.
The disposable PostgreSQL server was stopped cleanly after testing.

| Check | Result |
| --- | --- |
| Target classifier / migration / recovery UI | 3 / 3 PASS |
| Isolated PostgreSQL suite | 26 / 26 PASS, 0 SKIP |
| Google and Discord sequential collision | PASS |
| Google and Discord x2 / x10 / x100 races | PASS: one success, one identity, one owner, zero duplicates |
| Google and Discord natural x10 races | PASS |
| Duplicate pre-existing DB | Expected safe migration refusal; no deletion |
| Migration reapply / nullable schema / wrong-key protection | PASS |
| Synthetic Google-only actual Guild/private API isolation | PASS: no Guilds / HTTP 403 |
| Synthetic logout / same and cross-provider re-login | PASS; old sessions invalidated |
| Full suite | 445 total; 436 PASS, 9 SKIP, 0 FAIL |
| Build | PASS, local CI dummy configuration and remote Preview |
| TypeScript | PASS, standalone and build |
| JavaScript syntax | 158 modules PASS |
| Lint | 0 errors; 9 pre-existing warnings |
| Migration integrity | 9 unchanged legacy checksums + 1 Auth checksum PASS |
| Static schema drift | PASS |
| Repository token leak scan | PASS |
| Secret review | Changed/new-file review; no new credentials or secret files included |
| Critical production dependency audit | No known vulnerabilities |
| git diff --check | PASS |

The full-suite skips require external environments (including the opt-in Auth
PostgreSQL suite); that Auth suite was executed separately above. Local build did
not supply live OAuth credentials and emitted the expected missing-provider warning.
Remote Preview, which has the scoped credentials, built successfully.

## Production read-only audit

| Required fact | Result |
| --- | --- |
| Auth provider | Supabase; verified from the selected Production provider setting |
| Exact Auth project | UNKNOWN |
| Database name | UNKNOWN |
| Production identity duplicate groups | UNKNOWN; query not executed |

The Production connection entry is a Vercel **sensitive** environment variable.
Its read-only API metadata is available, but requesting the value does not recover
a usable connection string. No secret was printed, rotated, or replaced. A project
name inferred from an old canary alias is not sufficient to select a Production DB.
The user was asked only for the Production Auth project/database names, not credentials.

Production remains `dpl_CxTXYMep1A2Ua2Zyk1ouN1Dxqd4E` (READY).
The seven monitored Production Auth/legacy-DB settings retain their baseline update
timestamps. The project has no linked Git deployment integration. No Production
deployment, alias, environment change, DDL, DML, Bot/Worker restart or Termux update
was performed.

## Scope and recovery

Phase 0.5d changes are limited to the Auth hook, account constraint declaration,
safe recovery page, separate Auth migration tooling, tests/CI, and verification docs.
No dependency/lockfile, Bot ingestion, SQLite, Analytics/Projection, Cloud sync,
retention, or Discord Guild-authorization implementation changed.

If Preview application rollback becomes necessary, return its canary alias to the
previous Preview **while retaining the ownership UNIQUE constraint**. Migration
failure is transactional; there is no automatic destructive down migration.
Production migration must receive separate approval after its destination is known,
anonymous duplicate audit is zero, and the real OAuth gate is complete.

## Resume without repeating completed work

1. Finish selection of the existing linked Google account in the open canary login.
2. Complete Google/Discord real login, Guild denial, logout/re-login and Back/cache checks.
3. With a separately selected test account only, run Google-only isolation and real
   alternate-owner collision. Never damage the existing linked identity to simulate it.
4. Recheck anonymous Preview counts and ownership after those tests.
5. Identify the Production Auth project/database through trusted read-only configuration;
   only then perform its SELECT-only aggregate duplicate audit.

Do not repeat the successful migration, full suite, or x100 stress tests unless the
candidate changes. Do not merge or deploy Production based on this checkpoint.

**Phase 0.5e: NO-GO (incomplete real OAuth and Production-target evidence).**
**Production migration: NOT READY. Production recommendation: NO.**
**Production changes performed: NONE.**
