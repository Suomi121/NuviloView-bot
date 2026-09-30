# Guild Spam Detection Policy

## Existing behavior audited

The Bot currently tracks a message when it is in a Guild, is not a webhook, and is not authored by this Bot. Other bots are included. Counts are isolated by `guildId:userId` and use the global environment configuration:

- enabled unless `SPAM_PROTECTION_ENABLED=false`
- 3 messages in 5 seconds by default (`SPAM_MESSAGE_LIMIT`, `SPAM_WINDOW_SECONDS`)
- 5-minute automatic timeout by default (`SPAM_TIMEOUT_MINUTES`)
- 10-minute detection cooldown by default (`SPAM_DETECTION_COOLDOWN_MINUTES`)
- Guild owner and human members with administrative/moderation permissions are protected from automatic timeout, but may still be detected and alerted
- no duplicate-content, mention-count, link-count, cross-channel, ignored-role, or ignored-channel detector existed

## Compatibility and per-Guild policy

A missing policy row means the Guild continues to use the old global message-rate rule, audit, automatic timeout, and alert flow. Saving a policy explicitly switches that Guild to its saved thresholds and selected action. Preset values are server-validated; editing a threshold/window changes the preset to `CUSTOM`.

The `NORMAL` message-rate threshold matches the current default (3 / 5 seconds). Preset values for the newly added duplicate, mention, link, and cross-channel detectors are in `lib/guild-spam-policy.mjs`. These additional detectors are only evaluated when that Guild has explicitly saved a policy.

Custom actions are non-automatic:

- `LOG_ONLY`: create a local-first security moderation audit record, no Discord alert or automatic punishment
- `ALERT`: notify the configured moderation alert channel, no automatic punishment
- `INCIDENT`: create a local-first security audit record and notify moderators, no automatic punishment

Only Guilds with no custom row retain the legacy automatic timeout. Owners/moderators remain protected by the existing legacy timeout guard. The current Bot and webhook exclusions cannot be disabled. Optional exclusions can skip other bots, owners/moderators, selected roles, or selected channels.

## Storage, authorization, and safety

The web API stores policy in the existing shared Bot/Web PostgreSQL configured by `DATABASE_URL`, not in the Better Auth provider database. Reads and writes require an authenticated session plus that session's Discord-linked Guild list containing the requested Guild (owner or Manage Guild). Writes also require a trusted same-origin JSON request and are rate-limited. Policy row changes and the field-name-only audit record commit in one transaction. The audit does not store old/new setting values or names.

The Bot caches each Guild result for 30 seconds and coalesces concurrent refreshes. A missing row uses legacy behavior. A DB read error uses the legacy detection threshold but fails safe to `LOG_ONLY`; it does not apply an unknown timeout policy. Changes become visible to separate Bot/Web processes after the Bot cache expires (at most 30 seconds).

## Guild removal and retention

When a Guild is removed from the Bot, its saved policy row and policy audit history are **not automatically deleted** by the Guild removal handler or this feature. The handler invalidates that Guild's in-memory policy cache and clears its in-memory spam-detection windows/cooldowns only. Persisted policy and audit data remain subject to separately managed database retention and deletion; this migration creates no purge schedule or deletion guarantee. Retaining the audit history avoids silently erasing prior administrative changes. A future Guild data-retention/purge feature should define authorization, audit, and retention requirements before deleting these records.

Duplicate detection hashes normalized message text in memory and retains only the digest in the short-lived tracker window. Raw message content is not placed in policy rows, policy audit rows, or spam-policy logs. Dry-run analytics were not implemented; no moderation action is performed by any preview mechanism.

## Migration

`scripts/migrations/20260930-guild-spam-policy.sql` is a forward-only, additive migration registered in `scripts/migrations/manifest.json`. It creates only the Guild policy and policy-audit tables/index. It is approval-gated and has **not** been applied to any database as part of this implementation.
