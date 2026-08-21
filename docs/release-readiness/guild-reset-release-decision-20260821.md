# Guild Reset — production release decision

Date: 2026-08-21 (JST)

Decision: **NOT READY for production enablement**. Keep both the global and per-Guild feature flags off.

## Current safety controls

| Control | Status | Evidence |
|---|---|---|
| Registered developer identity | Implemented | Discord account linked to the authenticated session is checked against the server-side developer allow-list. |
| Guild scope | Implemented | The target must be connected, not blocked, and owned by the developer or explicitly list that developer in `allowedAdminIds`. |
| Explicit preview | Implemented | A Plan records exact channel, role, setting, and optional create counts before execution. |
| Two-step confirmation | Implemented | A short-lived one-time code is hashed, bound to Plan/Guild/developer, and consumed transactionally. |
| Replay/idempotency protection | Implemented | Used Plan/code checks, row locks, one-time request binding, and global/Guild execution locks reject duplicate confirmation. |
| Limits and cooldowns | Implemented | Channel, role, total-operation, per-Guild, and per-developer limits are checked again immediately before execution. |
| Snapshot drift detection | Implemented | The current Guild fingerprint must exactly match the Plan fingerprint before backup or mutation. |
| Backup before mutation | Implemented with constraint | JSON is written with exclusive creation and verified by reading it back and calculating SHA-256. Storage is local to the Bot host. |
| Audit log | Implemented | Plan, execution, per-target outcome, request state, local JSON audit, and optional Discord log notification are recorded. |
| Partial failure handling | Implemented | Safe independent Discord API errors are recorded and the remaining ordered targets continue. |
| Rate limit / CSRF | Implemented | Developer APIs use authenticated identity rate limits, trusted Origin validation, JSON/content-length bounds, and server-side authorization. |
| Default-off isolation | Implemented | Commands are not registered and the dashboard queue is not processed while the global flag is false. |

## Exact reset scope

Guild Reset operates on the Discord Guild structure selected by its Plan:

- `channels_only`: eligible, non-protected Discord channels and categories;
- `channels_and_roles`: the above plus explicitly acknowledged, non-protected roles below the Bot;
- `settings_reset`: explicitly acknowledged Discord Guild settings listed in the Plan;
- optional creation of `general`, `logs`, and `rules`, disabled by default.

It does **not** delete members, kick or ban members, send DMs, create webhooks, rename the Guild, change its icon or owner, or operate on another Guild. It also does not delete NuviloView Analytics, Security incidents/policies, or reaction-role rules. The Developer Console's separate Guild block action has a different data-purge scope and is not part of Guild Reset.

## Why production enablement is blocked

1. Guild Reset backups currently live on one Bot host filesystem. They are not yet uploaded to durable shared storage and are not encrypted by this feature.
2. The backup format is restoration-friendly, but a reviewed automated restoration workflow is not present; full restoration is not guaranteed.
3. Dashboard requests depend on the Bot poller. Host loss between queueing and processing is recoverable through stale-request requeue, but the operational procedure has not been rehearsed on both hosts.
4. Destructive execution has intentionally not been integration-tested against a production Guild. Unit tests cover selection, protection, confirmation, backup failure, partial failure, and lock release only.

## Required promotion gate

- Put reset backups in encrypted durable storage with access logging and a tested restore-preview/download path.
- Rehearse Dry Run and a bounded disposable-Guild execution using non-production service identity.
- Verify dashboard queue recovery after Bot restart and prove only one worker processes requests.
- Review the actual protected channel/role configuration for the first enabled Guild.
- Keep `channels_only`, `dryRun=true`, role deletion off, settings reset off, and default-channel creation off as initial defaults.
- Enable one allow-listed test Guild first; do not globally enable all Guilds.

## Rollback

Set `GUILD_RESET_ENABLED=false` on Web and every Bot host, restart only the affected runtime after approval, and set per-Guild `enabled=false`. Preserve Plans, confirmations, executions, audit items, and backup files for investigation. Do not run a down migration during an incident.
