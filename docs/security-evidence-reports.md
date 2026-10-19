# Security Engine v2 Phase C — evidence / suspected false-positive reports

## Source and release boundary

Base: main `7088dd41658b85094eae7bfacc9bf6e76cf8d8cb`, containing merged PRs
#33 → #34 → #35 → #36 → #37. Phase C adds no command, migration, table,
punishment path, detection threshold, policy mutation, consent mutation or
Timeout解除. PR-D1–D4 are deliberately separate, subsequent releases.

Read-only baseline verified 2026-10-19:

| Component | Observed source | State |
| --- | --- | --- |
| main / live Bot | 7088dd41658b85094eae7bfacc9bf6e76cf8d8cb | Bot NORMAL, Discord ready |
| Web | 8cb09e483ce702fd17a90df5c183a8d7cfb9d1ca | dpl_7LBrDvH8W4SVd52QzCBC3yi4yRM5 READY |
| Worker / Supervisor working directory | 413a03d60511c3e64ab9f853dfa56fba4bf45bb0 | Worker HEALTHY; unchanged shared runtime |

The Web intentionally lacks only the Bot-specific PR #37 hotfix. This is not
proof that the whole Production system runs one SHA. No Production mutation
is part of this PR. Existing SQLite/WAL, queues and runtime files are untouched.

## Discord log and component binding

New successful-timeout logs retain the two-step send / persist IDs / edit flow.
They show title **スパム検知**, the original dynamic Japanese narrative,
absolute/relative Discord timestamps, actual requested Timeout duration, escaped
user display fields, Case ID, then one row with **検知データを表示** and
**誤検知を報告**. No raw JSON/other attachment is posted publicly.

Stable `nvsec:e:timeout-…` / `nvsec:r:timeout-…` identifiers are <100 characters.
The boot-time interaction handler works without in-memory collectors. Before
disclosure or reporting it verifies:

- ACK before any async read (`deferReply` then `editReply`, no fallback `reply`).
- PR35 `authorizeSecurityOperator`, fresh Guild/member/roles and operator DB state.
  Owner/Admin also require an available, valid settings read in this handler.
  A registered operator role does NOT grant settings/mutation permissions.
- Exact Guild ownership of detection and every stored Timeout/log stage.
- Stored log channel + Message ID, Bot author, live re-fetched message, viewer's
  channel access, no attachments/content, and recorded visible message/button
  fingerprint. Edited, copied, missing, expired or cross-Guild cases fail closed.

The fingerprint covers application-authored embed text/fields/footer and button
labels/styles/IDs. Discord-generated rich type/component IDs are ignored.
An edit with an ambiguous result can leave an unavailable button; it must not
cause replay. Old PR36 logs have no fingerprint/buttons and are not backfilled.

## Evidence and TXT

Only typed PR36 evidence is projected: rule enum + derived safe reason, aggregate
count/window, source channel, timestamps, outcomes, allow-listed error code,
version and commit. No raw stored reason/error is trusted. No message text,
names, email, OAuth, token, ENV dump, stack trace, DB files or other-Guild rows
are included. Historic strength is **UNKNOWN (not recorded at detection)**;
current settings are never used to invent historic evidence.

Evidence is returned only after authorization, as an ephemeral UTF-8 TXT.
Developer report TXT also contains the report ID, reporter ID/time, Guild/target
IDs and `SUSPECTED_FALSE_POSITIVE` (not a confirmed verdict).
Filename: `nuviloview-false-positive-<report-id>.txt`.
All IDs/filenames are generated or strictly validated, not user-supplied paths.
Buffers are generated in memory, capped at 16 KiB; no temporary file is written.

## Private developer receiver (not configured by this PR)

There was no existing false-positive receiver in the source. Do not repurpose
an alert webhook or infer a channel from `DISCORD_DEV_GUILD_ID`.

Bot-only, non-secret configuration names:

- `SECURITY_REPORT_GUILD_ID`
- `SECURITY_REPORT_CHANNEL_ID`
- `SECURITY_REPORT_RECEIVER_ROLE_IDS` (optional, comma-separated, at most 10)

Without a valid pair, response is exactly
「開発者への送信先が設定されていないよ。」 and no claim/send occurs.
No real IDs or credentials are configured here.

An explicitly approved developer-private GuildText channel must deny
ViewChannel to @everyone. All explicit ViewChannel grants must be configured
developer roles, Administrator roles, Bot or Guild owner; unapproved member
grants, managed roles, public access, wrong Guild and missing permissions deny
delivery. Overwrites are bounded at 50. Bot requires ViewChannel, SendMessages,
AttachFiles. Global Discord Administrator/owner access is inherent to Discord;
the receiver Guild's staff and configured roles must be reviewed before release.
No permissions are automatically granted or channel created.

## Durability and failure boundaries

Existing SQLite `security_audit` and its transactional security Outbox are reused.
There is **no new DB schema/migration and no Worker change**. Replication carries
events as data; it does not perform Discord sends.

| Immutable event suffix | Meaning |
| --- | --- |
| `report_claim` | unique per Incident; reporter, report ID, receiver IDs |
| `report_sending` | intent durably recorded before external request |
| `report_sent` | Discord returned actual Message ID |
| `report_result` | SENT / FAILED / UNKNOWN + safe error code |
| `report_view_<user-id>` | first evidence disclosure audit for that user/case |

Report ID is deterministic SHA-256-derived `NV-FP-…`, separate from Incident ID.
SQLite's existing event-ID uniqueness and atomic Audit+Outbox transaction elect
one winner even across concurrent clicks / reopening the same file. A crash
after claim is CLAIMED, after send intent is UNKNOWN unless a durable SENT is
present. No automatic release/retry of a claim, including definite send failure.
A post-send disk failure is NOT a reason to resend.

The report-only REST transport uses the existing Bot token in memory, never
prints it, and has retries=0, timeout=10s, reject-on-rate-limit, stable nonce and
enforce_nonce. Other Bot REST behavior is unchanged. This provides at-most-one
send attempt, not exactly-once guaranteed delivery. Success UI requires both
Discord success and durable receipt. 4xx is FAILED; network/5xx is UNKNOWN.
Manual recovery must first reconcile stored destination/Message ID and Discord
history using a separately approved process; never delete claims to retry blindly.

No timeout解除 or moderation method is called by these handlers.
Bounded work: 4 concurrent handlers, 5-second per-user/Guild limiter, maximum
5,000 active limiter keys, 16 KiB files. Unavailable DB/source/receiver fails
closed without dumping errors or stopping the Bot. An outstanding lookup keeps
its concurrency slot until settled; it is not cancelled and then re-run.

## Retention / deletion design

Evidence access and new reporting expire 90 days after detection (including
after restart); future timestamps are rejected. This is an **access lifetime**,
not a claim that existing Audit replicas or Discord uploads are auto-deleted.
Local files are never produced. Existing Audit retention is unchanged.

For release, the operator must approve the following deletion runbook alongside
the receiver's Discord retention/access policy:

1. Plan a bounded, Guild-scoped export of IDs/counts only for expired incidents;
   retain an access-denial/report-deduplication tombstone if originals are removed.
2. Reconcile pending/UNKNOWN reports before deleting evidence. Delete developer
   TXT messages using recorded destination/Message IDs through an approved
   privileged operation; track unknown deliveries for manual reconciliation.
   Deleting local records alone does not delete Discord attachments.
3. Apply coordinated deletion of parent/stages/view/report metadata and synced
   replicas via existing retention/privacy operations **only after separate
   approval**, verified backups and tombstones. Never re-enable reporting by
   deleting a claim while an accessible Incident/log remains.
4. Verify unavailable evidence, no resend and aggregate deletion results without
   publishing private contents. Production cleanup is NOT implemented/executed
   here; no automatic destructive cleanup is introduced.

## Validation / release gate

Mock Discord tests cover permissions/revocation, cross-Guild references, live
message integrity, early ACK/10062, DB errors, bounded evidence, private receiver,
send outcomes, concurrent claims, SQLite restart and no double reports.
Loopback HTTP tests exercise actual discord.js multipart serialization and
200/403/429/503 with exactly one request and no global REST change.
Existing isolated PostgreSQL job additionally exercises real operator settings
reads, revocation, missing-table outage and Guild isolation against this handler.

Local validation on 2026-10-19: Phase C + PR36 tests **66 PASS**; isolated
PostgreSQL 18.4 + actual command runtime **24 PASS**; full Windows suite
**730 PASS / 10 SKIP / 0 FAIL**. Build, TypeScript, release contract, 209-module
syntax, 14 migration checksums (+ separate Auth manifest), static schema drift,
token scan and diff check PASS. Lint: 0 errors / 8 existing warnings. Production
dependency audit: Critical 0; existing High 4 / Moderate 1 / Low 1, unchanged
lockfile. Backup DryRun used only a temporary 0-byte gitignored `.env.local`,
without credentials or DB connections; it is removed after validation.

Real developer receiver permissions, real Discord render/send and real button
clicks remain unverified. No real Timeout is used for testing. Before separately
approved rollout: review receiver/retention, re-run CI, preserve v2 consent and
emergency guards, stage Bot-only cutover, do not reapply existing migrations.
Do not merge, deploy, restart or register commands as part of Phase C development.

Official constraints checked against Discord's docs:
[Interaction ACK](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx),
[components](https://github.com/discord/discord-api-docs/blob/main/developers/components/reference.mdx),
[message nonce / allowed mentions](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx).
