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
| pnpm audit remediation | CI dependency audit | 2026-08-21 20:36 | 2026-08-21 20:38 | SUCCESS | The audit command now uses the committed pnpm lockfile and nanoid is pinned to its patched 3.x release. | Local pnpm production audit reports no known vulnerabilities; PR rerun pending |

## Production operations

| Operation | Target | Started at | Completed at | Result | Safe summary | Verification |
|---|---|---:|---:|---|---|---|
| GitHub PR and merge | `feat/release-readiness-20260821` to `main` | 2026-08-21 20:31 | pending | START | PR #2 was opened by normal push. Force push and direct main push are not required. | Pending successful CI and head SHA review |
| Production migration | Neon PostgreSQL | pending | pending | START | Only checksum-verified additive migrations are candidates. No DROP or TRUNCATE is required. | Pending schema/index/application checks |
| Production Web deploy | Vercel `nuviloview-oem` | pending | pending | START | Backward-compatible deploy with destructive feature flags kept off until their own gates pass. | Pending HTTP/API health checks |
| Distributed singleton | Windows and Android/Termux | pending | pending | START | Blocked until Android can receive and verify its fixed host ID and singleton environment safely. | One-owner and fencing verification required |
| Production failover | Android/Termux and Windows | pending | pending | START | Must not run while either host is uncoordinated. | Lease expiry, owner handoff, Discord READY and stale-owner rejection required |
| Security auto containment | Per-Guild Security v1 policy | pending | pending | START | Promotion requires seven-day evidence, trusted actors and complete audit permissions. Unknown actors remain ineligible. | Policy and incident review required |
| Guild Reset | Global and per-Guild flags | pending | pending | START | Production enable remains blocked by durable encrypted backup and restore-rehearsal gates. | Dry Run and disposable-Guild rehearsal required |
| Secret rotation | Production secret stores | pending | pending | START | No confirmed leak has been found; rotate only if a concrete need is identified. | Inventory and leak scan required |

## Rollback anchors

- Git: previous known-good `origin/main` was `38f2125d09af4cb5bb21a6a09ee397833f63c0e5` at preflight.
- Database: verified backup set `20260821-183211-e045480e` exists on both F and G; secret scan and restore verification passed.
- Runtime: disable new feature flags first, then run exactly one known-good Bot host.
- Web: promote the previous known-good immutable Vercel deployment.

No secret values, Bot tokens, database credentials, OAuth secrets, IP addresses from user requests, or raw environment contents are recorded here.
