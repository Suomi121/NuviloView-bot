# Timeout incidents and Discord logs (PR-B)

## Dependency and scope

Base: PR #35, `94284b1d3bc5ccacc45d4497570d8a77c49f3902`.
Dependency order: #33 (Reset retirement) → #34 (all-Guild v2 consent) →
#35 (operator roles) → this PR. All three were open at implementation time.
Main inspected: `92d4b17eee90656e46db8617820602d2c508c0a3`.

This change integrates into the existing `handleSpamDetection` automatic timeout
path. The existing `GuildMember.timeout(SECURITY_V2_TIMEOUT_MS, ...)` remains the
single automatic punishment call. It does not introduce a second executor.
Fresh member/Bot permission checks, protected-member checks, current timeout
checks, local emergency flag and the uncached v2 consent check before execution
remain required. Missing writable local storage prevents execution.

Detection is recorded even while Auto Timeout is OFF, consent is missing,
the settings DB fails, or emergency stop is active. No successful-timeout
channel log is sent for those incidents. This replaces the old automatic
alert's arbitrary channel search and its punishment buttons. Existing stale
manual-action interaction handlers retain their original permissions.

## Commands and configuration ownership

`/tosetlog set channel:#log`, `/tosetlog off`, `/tosetlog status` use the existing
Guild command registration/dispatch mechanism. Only a freshly verified Guild
Owner or Administrator can use them. Manage Guild alone and operator roles
do not authorize this configuration. Set accepts an ordinary Guild text channel
visible to the actor and accessible to the Bot with View Channel, Send Messages
and Embed Links. Permissions are checked again when sending.

Shared Bot/Web PostgreSQL owns `guild_security_log` and
`guild_security_log_audit`. A single SQL statement saves the destination and
its audit atomically; Guild-row revisions serialize concurrent changes.
Off stores `channel_id = NULL`, preserves audit and does not delete policy,
consent or incident records. No cache is used for this destination.

The forward-only `20261019-security-timeout-log` migration adds only those
tables and an audit index. It is transactional, checksummed and manually
approval-gated. There is no bulk Guild update, Auth table change or local
SQLite schema migration. Old code ignores the new tables. Before rollout,
review the complete pending migration plan including dependencies; the existing
runner applies all pending migrations. No Production migration ran here.

## Incident and independent outcomes

Existing writable SQLite `security_audit` is the local source of truth.
Every stage and its existing security-domain Outbox envelope are one SQLite
transaction. Existing Worker/provider delivery, retry, circuit breaker and DLQ
handling replicate these events; this PR changes none of those mechanisms.

The Incident ID is a stable SHA-256-derived ID over Guild, target and triggering
message IDs. Stored evidence is allow-listed rules, deterministic rule labels,
aggregate count/window, detection channel/time and runtime version/commit.
Raw message bodies, tokens, arbitrary provider errors and stacks are excluded.
Runtime version/commit come from existing runtime identity metadata. Missing or
invalid metadata is explicitly `UNKNOWN`; rollout should supply the existing
`NUVILOVIEW_VERSION` / `NUVILOVIEW_COMMIT_SHA` metadata accurately.

Immutable event stages:

| Stage | Meaning |
| --- | --- |
| Incident / `spam_detection` | Detection only; never asserts punishment |
| `timeout_claim` | Durable exclusive permission to attempt this incident |
| `timeout_api` | API start, requested duration and scheduled end |
| `timeout_result` | success / failed / skipped / unknown; returned actual end if available |
| `log_claim` | Exclusive send attempt after persisted timeout success |
| `log_sent` | Confirmed Discord channel and Message ID |
| `log_result` | sent / failed / unknown / sent_edit_failed; allow-listed error code |

The snapshot method requires the caller's Guild ID and exposes each outcome
separately for PR-C. It never interprets a pending attempt as success.
Success recording failure after the Timeout API returns does not get recast as
an API failure. No log is sent without persisted success.

## External side effects and crash behavior

Exactly-once Discord delivery across an arbitrary crash cannot be proven by a
local transaction. This implementation chooses durable at-most-once attempts:
an existing detection or claim prevents automatic re-execution, including after
restart or redelivery. Network/server errors can have an unknown remote outcome;
they are recorded as unknown rather than claiming failure or retrying.

Discord's bounded internal HTTP handling is retained. The message send uses a
stable nonce with `enforceNonce` to deduplicate SDK retries within Discord's
documented nonce window. SDK timeout PATCH retries use the same prepared expiry
body. There is no application-level retry loop, reroute, or Discord action in
the sync queue. A crashed in-flight attempt stays `pending_or_unknown` for
operator review; this PR does not automatically replay it. Consequently a crash
before a confirmed send may leave a missing log. Safety takes precedence over
repeating a punishment or posting a duplicate. Preserve the SQLite database/WAL
and its claims during rollout and any rollback; do not restore an obsolete
database over a live runtime.

API reference: [Discord Create Message / Edit Message](https://docs.discord.com/developers/resources/message).

## Message delivery and presentation

Dedicated destination if configured; otherwise only the triggering detection
channel, and only after confirmed Timeout success. Failed configuration reads
are not treated as an unset destination. Deleted, inaccessible or unsendable
dedicated channels never trigger a different destination.

First send contains the confirmed timeout, absolute/relative Discord timestamps,
actual requested duration and user fields, without a delivery-success sentence.
After Discord returns, its actual channel/Message ID are persisted, then the
same message is edited once to add “通知メッセージは … に送信されたよ”.
An edit failure leaves the accurate original message and a separate internal
failure result. It does not create another message or expose error prose publicly.

Names are bounded and escaped, unavailable names say “取得できません”, and
`allowedMentions` prevents notification injection on both send and edit.
The reference image informs the two-section layout. No copied branding,
public raw evidence attachment or PR-C button is included.

## Verification and release limits

Mock tests cover settings permissions, routing, safe text, timestamps, outcome
separation, duplicate processing, SQLite reopening and failure boundaries.
An isolated localhost PostgreSQL verifies persistence, Guild separation,
concurrent revisions and audit rollback. No Production resource is used.
Live Discord rendering, real sends, real Timeout, registration and rollout
remain unverified and require a separately approved release.

For PR-C, reuse `authorizeSecurityOperator` from PR #35 for every operation,
the Guild-scoped incident snapshot and its allow-listed evidence. This PR
implements no report button, TXT delivery, developer receiver or `/reportbug`.
