# Phase 0.5d — Provider identity concurrency fix

Reviewed: 2026-09-06. Scope: NuviloView Web Auth only.

**Result: CONDITIONAL GO for the isolated fix candidate. Production recommendation: NO.**

Base commit: `865286cabb59a98591ef90e88df15d0cf8586dca`.
Work branch: `fix/provider-identity-concurrency-phase05d`.
No merge, push, deployment, Production DDL/DML, environment change or Bot/Worker restart was performed.

## Verified identity contract

Installed/locked Better Auth: **1.6.25**, native PostgreSQL pool through the built-in Kysely adapter.
Do not substitute the different identity/issuer semantics in current v1.7 documentation.

| Field / structure | Actual contract |
| --- | --- |
| Table | `public.account` |
| Local row primary key | `id`, text, NOT NULL |
| Provider namespace | `providerId`, text, NOT NULL |
| External provider subject | `accountId`, text, NOT NULL |
| Owner | `userId`, text, NOT NULL, FK to user with cascade |
| Previous indexes | PK; non-unique user index; non-unique provider/account index |
| Added guarantee | non-deferrable UNIQUE `account_provider_identity_unique(providerId, accountId)` |
| Owner in unique key? | **No** |
| NULL bypass | Base schema already disallows NULL. Migration rejects nullable/drifted schema rather than claiming it is protected. |
| Credential accounts | Same table; v1.6 sets accountId to the internal user ID and providerId to credential. Different users' credentials remain valid. Password sign-in is not enabled by this change. |

Local evidence: `docs/sql/web-auth-supabase-v1.sql`, `lib/db/schema.ts`,
installed `better-auth/dist/api/routes/callback.mjs`,
`better-auth/dist/db/internal-adapter.mjs`, and password route.
The callback rejects a missing/null/empty provider subject before constructing an account.
The identity lookup filters by accountId AND providerId; it does not use email as the ownership key.

Primary references checked on the review date:

- [Better Auth v1.6 database schema](https://better-auth.com/docs/1.6/concepts/database)
- [Better Auth v1.6 accounts and linking](https://better-auth.com/docs/1.6/concepts/users-accounts)

## Root cause and correction

The sequential ownership check preceded a separate INSERT. Parallel callbacks could all
observe no existing identity and each create a different owner's row. A transaction or
per-process mutex alone is not the fix.

The database now guarantees unique provider subject ownership across all application instances.
The existing bootstrap and the nine legacy migrations are unchanged.
The new Auth-only migration has its own checked manifest, because the existing Bot/Neon
migration runner must not apply its unrelated migrations to the dedicated Auth database.
The Drizzle declaration matches the new UNIQUE constraint.

A request-local Better Auth before hook wraps only account creation in Google/Discord
OAuth callbacks. It catches PostgreSQL 23505 **only for this named ownership constraint**,
including a bounded cause chain. The loser gets a fixed same-site recovery redirect.
Other unique errors, FK errors, DB outages and arbitrary messages are not misclassified.
OAuth state/PKCE/CSRF/session validation stays with Better Auth.
There is no upsert that could move an identity, token overwrite of the winning owner,
application-wide serialization, or bypass of the original callback.

The error page uses an allowlisted error code and a fixed Japanese message. Raw SQL,
constraint names, driver detail and stack traces are not rendered.

## Cloud Preview audit

Read-only aggregation in the explicitly isolated **nuviloview-auth-preview**:

| Users | Accounts | Duplicate identity groups |
| ---: | ---: | ---: |
| 1 | 2 | 0 |

The Phase 0.5c race rows were created in local disposable PostgreSQL, not this Supabase project.
No Preview cleanup, reset or account deletion was needed.
This phase used the permitted **isolated local PostgreSQL** alternative for migration and
callback tests. The Supabase Preview migration and deployment have **not** been applied.
The existing deployed Preview must not be mistaken for the fixed candidate.

## Executed isolated integration tests

Windows, Node 24.18.0, PostgreSQL 18.4; fresh disposable test databases, synthetic identities only.
Actual repository auth configuration and installed Better Auth callback/session implementation.
Only external provider code/profile responses and the Auth storage destination are fixtures.
External HTTP is blocked; attempted external requests: **0**.

| Case | Result |
| --- | --- |
| Empty Auth database + repeated migration | PASS |
| Existing valid account rows | PASS; preserved |
| Existing duplicate identity | Expected failure; both rows preserved; no partial constraint |
| Nullable identity schema | Expected failure |
| Wrong same-name three-column/user-scoped constraint | Expected failure |
| Migration CLI default read-only plan | PASS; no constraint created |
| CLI wrong target confirmation | Rejected before mutation |
| CLI approved isolated target | PASS |
| Google sequential cross-user collision | Rejected; one owner |
| Discord sequential cross-user collision | Rejected; one owner |
| Normal Google → Discord linking | Same user, two identities |
| Google-only managed Guild / private snapshot API | Empty list / HTTP 403 |
| Different providers with the same subject text | Allowed as different identities |
| Credential identities for different users | Allowed |
| NULL subject insert | Rejected (23502) |
| Logout/re-login permutations | Old sessions invalid; same linked user retained |

Deterministic races synchronize **real identity SELECT completion** before INSERT; lookup
results are not falsified. This preserves the same Phase 0.5c reproduction. Also tested
unconstrained parallel scheduling without a barrier.

| Provider | Concurrency | Successful links | Identity rows | Distinct owners | Duplicate groups | Safe loser handling |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Google | 2 | 1 | 1 | 1 | 0 | PASS |
| Google | 10 | 1 | 1 | 1 | 0 | PASS |
| Google | 100 | 1 | 1 | 1 | 0 | PASS |
| Discord | 2 | 1 | 1 | 1 | 0 | PASS |
| Discord | 10 | 1 | 1 | 1 | 0 | PASS |
| Discord | 100 | 1 | 1 | 1 | 0 | PASS |
| Google (no barrier) | 10 | 1 | 1 | 1 | 0 | PASS |
| Discord (no barrier) | 10 | 1 | 1 | 1 | 0 | PASS |

Losers return HTTP 302 to the allowlisted conflict page, not a raw 500. The integration
assertions also reject SQL/token/stack detail in callback bodies.
Final database-wide duplicate group count: **0**.

Final isolated integration: **26/26 PASS** (including the parent test), no SKIP.
The scratch PostgreSQL server was gracefully stopped; synthetic database files retained.

## Reproduction / CI

`pnpm test` runs the unit/source tests and skips the integration fixture without explicit configuration.
`pnpm test:auth:postgres` requires all of:

- `TEST_AUTH_IDENTITY_DATABASE_URL`: loopback PostgreSQL, database named `nuviloview_auth_identity_test`.
- `TEST_AUTH_IDENTITY_ISOLATED=1`.
- Empty public schema, a disposable local cluster, and permission to create test databases.
- `AUTH_IDENTITY_STRESS=1` to include both 100-way tests.

No .env file is loaded by this test command. Never pass a Production URL.
The CI job uses a dedicated PostgreSQL service, synthetic credentials and read-only GitHub permissions.
It does not deploy or contact a Cloud Auth database. Remote CI has **not run** in this phase.

## Validation

- Target classifier/manifest/UI contract: 3/3 PASS.
- Full suite: **445 total, 436 PASS, 9 SKIP, 0 FAIL**.
  Eight existing external-environment skips; one new explicitly opt-in PostgreSQL test.
  That new integration is executed separately above, not claimed as passing through its skip.
- Build: PASS with existing CI dummy configuration.
- TypeScript: PASS (standalone and build).
- Lint: 0 errors; 9 existing warnings.
- JavaScript syntax: 158 modules PASS.
- Migration integrity: 9 unchanged legacy checksums + 1 new Auth checksum PASS.
- Static schema drift: PASS.
- Repository token scan: PASS.
- Changed/new-file generic secret scan: no new credential finding. The unchanged
  provider-config property reference in lib/auth.ts triggers the scanner's existing
  literal-assignment heuristic in both HEAD and the candidate. Added-line scan is empty;
  manual diff review confirmed this is a pre-existing code-reference false positive,
  not a secret value. The scanner was not weakened.
- Critical production dependency audit: no known vulnerabilities.
- No Bot ingestion, Local-First, Analytics, Sync Worker, retention or Cloud projection changes.

The candidate is in the working tree (six existing files modified, eleven new files),
not committed or pushed. Existing dependency versions and lockfile are unchanged.

Changed: Auth configuration, account schema declaration, recovery page, package commands,
migration validation entry point and isolated PostgreSQL CI job.
Added: request-local conflict hook; Auth migration SQL/aggregate audit/manifest/loader;
approval-gated migration runner and validator; unit and PostgreSQL integration tests,
callback fixture helper; this report.

## Migration operations and recovery

The checked migration is `scripts/auth-migrations/20260906-provider-identity-unique.sql`.
It uses a transaction, bounded lock/statement timeouts, duplicate audit under a table write lock,
and exact structure validation on rerun. Duplicate rows are never silently removed.
The existing non-unique lookup index is retained; removing a redundant index is not this phase.

1. Confirm the intended **Auth** database out of band, and obtain an approved backup.
2. Supply only the explicit `AUTH_MIGRATION_DATABASE_URL` to the Auth runner using a secret-safe
   environment. It has no DATABASE_URL or automatic Production fallback.
3. Run `pnpm auth:migration:plan`. It reports an anonymous duplicate count and a SHA-256
   target fingerprint, never the URL. A zero count alone does not authorize Production.
4. After separate approval only, execute the same runner with `--execute`,
   `--approve=20260906-provider-identity-unique`, and the exact `--expect-fingerprint=...`
   from the plan. The lock-protected audit executes again as part of the migration.
5. Reverify constraint, ownership counts, safe application error mapping and the OAuth matrix.

If duplicate groups are nonzero: stop; retain all rows; restrict new linking through a
separately approved operational change; review ownership and original linkage evidence with
the affected users/operators. Do not auto-pick the oldest/newest owner or auto-merge users.
Prepare an explicit, backed-up data repair plan separately.

On migration failure the transaction leaves no partial DDL and no deleted identities.
On an application regression, revert the application change **while retaining uniqueness**.
Do not automatically drop the constraint: that would restore the takeover-relevant race.
Any exceptional schema rollback requires separate approval, disabled linking traffic and an
explicit repair/restore plan. There is intentionally no automatic destructive down migration.

## Production and remaining OAuth matrix

Production Auth database connection definitively identified: **NO / UNKNOWN**.
Production duplicate groups: **UNKNOWN**. No speculative query against an old project was run.
Therefore migration status is **NOT READY FOR PRODUCTION REVIEW**.

Second Google test account real-OAuth isolation: **NOT TESTED**.
The local actual-API 403 test is not a substitute for that browser matrix.
Real alternate-user identity collision and remaining real logout/re-login permutations also
remain separate approval evidence; synthetic callback coverage must not be relabeled as real OAuth.

**Concurrency Integrity: PASS (isolated). Production Recommendation: NO.**
**Production changes performed: NONE.**
Do not merge, migrate Production, change Production environment, or deploy.
