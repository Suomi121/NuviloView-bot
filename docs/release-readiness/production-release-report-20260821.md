# NuviloView 0.2.0-rc.1 — production release report

Date: 2026-08-21 (JST)

## 1. Executed Production Changes

- Applied the checksum-protected additive migration set and created the migration journal.
- Deployed the Web/API release to Vercel and the latest Bot to the Windows host.
- Enabled Message History Import v2 on Web and Windows Bot after schema verification.
- Stopped the Android Bot before the Windows restart, leaving exactly one active Bot host.
- Added and activated independent five-minute monitoring through GitHub Actions.

## 2. Skipped / Not Required

- `DROP` / `TRUNCATE`: not required; no obsolete object justified destructive removal.
- Force push and direct `main` push: not required; normal PR merges succeeded.
- All-host production singleton and real-host failover: safety-gated by missing Android configuration control.
- Security automatic containment and Guild Reset: safety gates remain incomplete.

## 3. Git / GitHub

- PR #2 merged release readiness and Message History Import v2 after CI success.
- PR #3 merged independent production monitoring after CI success.
- No force push and no direct `main` push were used.

## 4. Production Deploy

- Vercel final deployment: `dpl_8G9fY2Jfa4vfp9DBWtprXDnKMmco`, Ready and aliased to the production domain.
- Windows Bot: current release, auto-restart enabled, fresh heartbeat, 12 connected Guilds.
- Android Bot: intentionally stopped and retained as an unavailable standby until configuration is safe.

## 5. Database

- Eight migrations report `applied` with valid checksums.
- Nine retention indexes and the Message History Import v2 schema are present.
- No Analytics messages or Guild data were deleted.
- The current PostgreSQL client warns that future major-version SSL semantics will change; current connections remain operational.

## 6. Singleton

- Implementation, schema and isolated DB coordination are verified.
- Production flag remains off because Android cannot remotely receive a unique `hostId` and matching configuration.
- Stable runtime state is one Windows Bot process and no production lease.

## 7. Failover

- Isolated real-DB rehearsal passed eight checks: contention, TTL takeover, fencing increment, stale renew/release rejection and new-owner renewal.
- Android/Windows production failover was not attempted because its prerequisite configuration was unavailable.

## 8. Security

- Global Security v1 detection is available; 13 Guild policies remain Shadow.
- Automatic containment and auto restore remain off.
- Four Guilds report missing permissions and no trusted actors are registered.

## 9. Guild Reset

- Global and per-Guild enablement remain off.
- No settings, execution, reset backup or active request exists.
- Durable encrypted backup and a disposable-Guild restore rehearsal are still required.

## 10. Backup

- Backup set `20260821-204609-7c9505a6` exists on F and G.
- Both copies passed checksum, source archive and PostgreSQL restore verification.
- Secret screening passed; encryption is not configured; the automatic runner remains stopped.

## 11. Monitoring

- The production monitor endpoint returns only `ok` or `down` after token authentication.
- GitHub Actions checks it every five minutes from an independent host.
- Manual end-to-end run `32480518057` passed.
- Direct DB monitoring still reports intermittent latency around 1.5–1.7 seconds as a Warning.

## 12. Secrets

- Only the unusable monitoring credential was rotated.
- Vercel and GitHub received the same new value directly from memory.
- Discord, database, OAuth and other API credentials were not rotated without evidence of need.
- No secret value is stored in this report, Git history or release metadata.

## 13. Tests

- 245 automated tests passed after the monitor addition.
- TypeScript, production build, migration validation and token leak scan passed.
- Lint reports zero errors and twelve existing warnings.

## 14. Rollbacks Performed

- No production rollback was required.
- Two earlier CI failures and one backup screening failure were isolated before production mutation, fixed, and revalidated.

## 15. Remaining Risks

- No production Android/Windows singleton/failover evidence.
- Backup artifacts are not encrypted and automatic backup scheduling remains disabled.
- Security trusted actors and four Guild permission sets are incomplete.
- Guild Reset lacks durable encrypted storage and an operator restoration rehearsal.
- Neon latency warnings recur; the future PostgreSQL SSL-mode semantic change needs planned remediation.

## 16. Final Release Readiness

The Web/API, Windows Bot, additive database schema, Message History Import v2 and independent monitor are production-ready as a release candidate. The release is not a stable all-features declaration: distributed all-host runtime, Security automatic containment and Guild Reset remain deliberately gated. Publish as `v0.2.0-rc.1` prerelease, not as a stable release.
