# Security v1 production conditions

Reviewed: 2026-08-21

Security v1 is already integrated. It must be promoted by policy, not by adding another detection implementation. The global feature flag only makes detection and the authenticated dashboard available; every newly created Guild policy still starts in `shadow`, with `automaticContainment=false` and `autoRestore=false`.

## Current verified state

- Both additive Security migrations are present and applied to the current database.
- Incident, incident-action, trusted-actor, snapshot, audit-event and action-request storage is available.
- Every observed Guild policy is enabled in `shadow` mode.
- Automatic containment and automatic restore are disabled for every observed Guild.
- The Bot self actor, Guild owner and configured trusted actors are excluded from containment.
- Browser requests are re-authorized against the signed-in Discord identity and the requested Guild. A managed-Guild result alone grants view access; policy, containment and restore scopes require the Discord Guild owner.
- State-changing routes require a trusted Origin, JSON size bound and fail-closed rate limit.
- Alerts suppress mentions and only update when incident severity increases.

## Promotion gate

Keep a Guild in Shadow until all of the following are true:

1. At least seven representative days of audit-log evidence have been reviewed.
2. Unknown-actor and delayed-audit-log cases have been measured and documented.
3. Trusted Bots and integration actors have been explicitly registered.
4. Required Bot permissions and the alert channel pass the diagnostic check.
5. High/Critical incidents have an operator-reviewed false-positive rate acceptable to that Guild.
6. Snapshot preview has been checked without applying a restore.
7. The operator has rehearsed manual containment on a non-production test Guild.

`monitor` may be enabled after this gate for detection and alerting. `manual` may be enabled for owner-confirmed dangerous-role removal. `protect` or `strict`, automatic Kick, and automatic restore require a separate explicit approval per Guild and remain out of scope for this release-readiness pass.

## Safety boundary

Security v1 never automatically bans members, sends DMs, creates Webhooks, performs bulk role changes, mentions everyone, or crosses Guild boundaries. Audit-log actor correlation is best effort: missing Discord audit evidence remains `Unknown Actor` and cannot be contained. Snapshot restore is a reconstruction aid and not a guarantee of perfect restoration.

## Rollback

1. Set the affected Guild policy to `shadow`.
2. Disable automatic containment and automatic restore.
3. If necessary, set `NUVILOVIEW_NUKE_PROTECTION=false` on Web and Bot hosts and restart only the Bot process.
4. Preserve incidents, audit events and snapshots for review; do not run the down migration during an incident.
