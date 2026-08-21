# NuviloView Nuke Protection v1

Nuke Protection v1 is a defensive subsystem for detecting, explaining and
recording rapid destructive Discord Guild administration activity. It is
isolated from message analytics and does not inspect or store message content.

## Architecture

```text
Discord GUILD_AUDIT_LOG_ENTRY_CREATE
  -> action classifier and safe metadata filter
  -> actor-scoped risk / Security v1 threshold window
  -> incident correlation and evidence storage
  -> common response layer (monitor / protect / strict)
  -> dashboard / optional Discord channel alert / restore preview
```

The Bot consumes the Gateway audit-log event rather than repeatedly scanning
the full Guild audit log. Audit entry IDs are unique in the evidence table, so
Gateway reconnects and Bot restarts do not duplicate the same action. Open
incidents and their risk window are rebuilt from PostgreSQL evidence.

Discord specifications used by the implementation:

- [Gateway Events](https://docs.discord.com/developers/events/gateway-events)
- [Gateway Intents](https://docs.discord.com/developers/events/gateway)
- [Audit Log Resource](https://docs.discord.com/developers/resources/audit-log)
- [Permissions and role hierarchy](https://docs.discord.com/developers/topics/permissions)
- [Rate Limits](https://docs.discord.com/developers/topics/rate-limits)

## Required Discord access

| Capability | Requirement | Behavior when missing |
| --- | --- | --- |
| Audit event detection | `VIEW_AUDIT_LOG` and `GUILD_MODERATION` intent | Guild status is `Limited`; the rest of the Bot continues |
| Structure snapshots | `GUILDS` intent and cached Guild structure visible to the Bot | Snapshot contains only objects visible to the Bot |
| Manual dangerous-role removal | `MANAGE_ROLES`, with the NuviloView role above the target role | Operation is rejected or records partial failure |
| Automatic channel/role recovery | `MANAGE_CHANNELS` / `MANAGE_ROLES`, with Discord hierarchy respected | Incident remains recorded and each failed object is reported |
| Automatic malicious Webhook cleanup | `MANAGE_WEBHOOKS` | Detection remains active; cleanup failure is recorded |
| Bot-spam message cleanup | `MANAGE_MESSAGES` in the affected channel | Incident remains recorded without deleting unavailable messages |
| Optional actor Kick | `KICK_MEMBERS`, with Discord hierarchy respected | Incident remains recorded and the Kick failure is reported |
| Alerts to a Discord channel | `VIEW_CHANNEL` and `SEND_MESSAGES` for the configured channel | Dashboard alert remains; channel is shown as unavailable |

`Administrator` is not required by Nuke Protection. Discord role hierarchy is
always applied. NuviloView never claims that it can manage a member or role at
or above its own highest role.

## Monitored audit actions

Security v1 creates typed incidents only after the configured bot-actor
threshold is reached:

| Detector | Default threshold |
| --- | ---: |
| Channel / Category create or delete | 5 operations / 60 seconds |
| Role create or delete | 2 operations / 60 seconds |
| Webhook create | 2 operations / 60 minutes |
| Same-content Bot messages | 5 messages / 20 seconds |
| Bot `@everyone` / `@here` messages | 3 messages / 20 seconds |

The Channel, Role and Webhook detectors act only on Bot executors in Security
v1. NuviloView itself and Guild-configured trusted Bots are excluded. Webhook
Update and Delete events are not counted as Webhook creation.

The earlier explainable risk engine continues to classify these additional
administrative audit actions:

- Channel Delete
- Role Delete
- Member Ban and Member Kick
- Webhook Create and Delete
- Integration Delete
- Bot/Application addition
- Guild setting change
- Administrator permission grant
- dangerous Role permission creation/update
- dangerous Channel permission overwrite creation/update

Actor ID, target ID, action type, audit entry ID, timestamp and Guild ID come
from the Discord audit entry. If Discord does not identify the executor, it is
stored as `Unknown Actor`; NuviloView does not guess from nearby administrators.

## Risk scoring

Default action weights:

| Action | Points |
| --- | ---: |
| Channel Delete | 25 |
| Role Delete | 25 |
| Administrator Grant | 30 |
| Dangerous Permission | 20 |
| Member Ban | 8 |
| Member Kick | 6 |
| Webhook Create / Delete | 10 |
| Bot Addition | 15 |
| Integration Delete | 15 |
| Guild Setting Change | 15 |

The engine evaluates 10-second, 30-second, 60-second and 5-minute windows.
Three destructive operations inside 10 seconds add 20 points; five inside 30
seconds add 40; two or more distinct action types inside 60 seconds add 15.
The raw total is capped at 100 for the displayed risk score.

Balanced severity thresholds are `Normal` 0–29, `Suspicious` 30–59, `High`
60–89 and `Critical` 90–100. Low sensitivity uses 40/75/95 boundaries; High
sensitivity uses 20/45/75; Custom accepts validated Guild thresholds. Each
incident stores base items, applied burst bonuses,
window boundaries and the raw total so the Dashboard can explain the score.
Invalid negative/out-of-order policy values fall back to safe defaults.

Guild owners, configured trusted actors and NuviloView itself remain visible as
evidence but their actionable risk is suppressed to zero. Trusted does not mean
invisible.

## Alerts

High and Critical incidents enter the existing Guild alert stream. A configured
Discord alert channel receives one incident message, updated only when severity
increases. Individual actions do not generate mention spam. Deleting the alert
channel does not disable detection or Dashboard alerts.

## Response and containment

Containment is unavailable in Shadow Mode. In Manual mode, a Guild owner must
confirm the Dashboard operation. The Bot removes only roles that:

- grant an explicitly dangerous permission;
- are not `@everyone` or managed/integration roles; and
- are below the NuviloView Bot's highest role.

Guild owners, trusted actors and NuviloView itself are rejected. Each Discord
operation includes the audit reason `NuviloView Nuke Protection incident <id>`.
Failures are recorded per role and safe remaining work may continue. Protect
and Strict modes can separately enable automatic Kick and Auto Restore. Both
options default to off and are unavailable in Shadow/Monitor modes. The common
response layer always protects the Guild owner, trusted actors and NuviloView
itself. Security v1 never automatically Ban, DM, mention, retaliate or contact
other Guilds.

## Snapshots and Restore Preview

Manual and at-most-daily snapshots contain channel/category relationships,
order, type, topic, NSFW/slowmode fields, permission overwrites, roles, role
order, permission bits, color, hoist, mentionable and managed flags. They never
contain Webhook tokens, Bot tokens, OAuth credentials, message content or
attachments. Each snapshot has a schema version and SHA-256 checksum.

The default retention is latest 7 snapshots and at most 30 days. Restore
Preview compares a snapshot to the current structure and separates deleted
channels/roles from permission changes. If Auto Restore is explicitly enabled
in Protect/Strict mode, the Bot recreates deleted Roles, then Categories, then
Channels and finally adjusts positions. Permission overwrites are remapped when
a deleted Role receives a new Discord ID, and child channels are reattached to
recreated or still-existing Categories. Every step is best-effort and does not
promise complete Discord restoration.

## Authorization scopes

The server rechecks the Better Auth session, linked Discord account, OAuth
managed-Guild list, connected Bot registry and blocklist for every request.
Browser-supplied Guild IDs are never trusted.

| Scope | v1 access |
| --- | --- |
| `ViewSecurity` | Discord user currently verified with Manage Guild or owner access |
| `ManageSecurityPolicy` | Guild owner |
| `ContainActor` | Guild owner |
| `RestoreStructure` | Guild owner |

This is intentionally independent from developer status. A NuviloView
developer cannot contain an actor in an unrelated Guild. The retired
No unrestricted cross-server inspection feature is introduced.

## Status and modes

- `Active`: audit detection requirements are present.
- `Limited`: detection or containment permission is missing.
- `Disabled`: global feature flag or Guild policy is off.
- `Error`: one Guild's engine failed; other Guilds continue.

Shadow Mode detects, scores, stores evidence and may alert, but refuses all
containment. Monitor remains detection-only; Manual allows owner-confirmed
dangerous-role removal; Protect and Strict make the separately enabled
automatic response settings available. New Guild policies always start in
Shadow Mode with automatic response disabled.

## Retention and privacy

Resolved/false-positive incidents and their cascading evidence are retained for
90 days by default. Snapshots default to latest 7 / 30 days. Completed action
requests are removed after 30 days. Security audit events are kept longer for
accountability. The public privacy policy lists the Discord IDs, action type,
target ID, timestamp and structure metadata this feature can store.

## Known limitations

- If NuviloView loses `VIEW_AUDIT_LOG` or is removed from a Guild, it cannot
  provide real-time protection; the registry/diagnostic status exposes this.
- Discord may not provide an executor for every situation; those entries remain
  `Unknown Actor` and cannot be contained.
- Current member roles are not reconstructed from historical incident evidence.
- Snapshot recovery cannot recreate original Discord object IDs and some
  Discord-managed/integration properties cannot be restored.
- Audit-log delivery can be delayed. Webhook creation lookup uses bounded short
  retries, but missing executor/audit permissions still prevent attribution.
- Automatic Ban is not part of Security v1. Automatic Kick and recovery require
  explicit Protect/Strict configuration and sufficient Discord permissions.
