# Local-First Finalization v1

## Runtime contract

With `LOCAL_FIRST_ALL_GUILDS_ENABLED=true`, every normal connected Guild routes
the following raw Discord data to the local SQLite database:

- Message create, edit, delete, bulk delete, and reply/reference metadata.
- Reaction add and remove transitions.
- Voice join, move, leave, open-session state, and restart reconciliation.
- Member join, leave, and role updates.
- Moderation and Spam audit records.

Blocked Guilds and the Bot's existing save exclusions remain enforced. Message,
Reaction, Voice, and Member handlers do not wait for Neon, Supabase, or Turso.
Raw analytics events are not enqueued to a Cloud provider. Analytics Compaction
builds bounded Current/Daily/Channel/User projections locally and the Sync
Worker replicates only changed snapshots.

## Required final-mode flags

```ini
LOCAL_STORAGE_ENABLED=true
LOCAL_STORAGE_WRITE_ENABLED=true
LOCAL_MESSAGE_STORAGE_ENABLED=true
LOCAL_FIRST_ALL_GUILDS_ENABLED=true
EVENT_LOCAL_FIRST_ENABLED=true
EVENT_LOCAL_FIRST_REACTION_ENABLED=true
EVENT_LOCAL_FIRST_VOICE_ENABLED=true
EVENT_LOCAL_FIRST_MEMBER_ENABLED=true
ANALYTICS_COMPACTION_ENABLED=true
SYNC_WORKER_ENABLED=true
MULTI_DB_SYNC_ENABLED=true
SYNC_SNAPSHOT_ENABLED=true
```

Supabase and Turso provider flags remain independently controlled by the
Multi-DB policy. Neon is optional and is not required by raw event persistence.
History Import flags remain independently OFF until their own rollout.

The Bot refuses to start final mode if writable SQLite, Message routing, any of
the three Event domains, Security audit storage, or all-Guild compaction is not
available. The old Guild lists remain as bounded emergency rollback targets;
they do not select routing while final mode is enabled.

## Message compatibility

Reply metadata is stored inside the existing message event payload, so no
SQLite or Cloud schema migration is required. Older rows without `reference`
remain valid. The optional object contains only IDs and the Discord reference
type; it does not fetch or duplicate the referenced message body.

## Security audit exception

Moderation and Spam actions must remain durable and reviewable even when the
Bot host is later lost. Their primary record is therefore appended to SQLite,
then an immutable `security` Outbox event may be replicated to the required
Cloud audit replicas. This is not raw analytics telemetry: it contains only the
bounded action/status/error audit fields needed for authorization review and
forensics. Discord handlers never await a provider write.

## Raw Cloud write guard

In final mode the expected direct/Outbox raw counts are:

| Domain | Direct Cloud writes | Raw Outbox events |
| --- | ---: | ---: |
| Message | 0 | 0 |
| Reaction | 0 | 0 |
| Voice | 0 | 0 |
| Member | 0 | 0 |
| Security audit | 0 direct | bounded immutable audit events |

Runtime snapshots, compacted analytics projections, Guild inventory, channel
access, configuration, authentication, and Web control records are separate
contracts and are not counted as raw analytics writes.

## Rollback

1. Stop the Bot gracefully and record SQLite health, size, WAL size, and queue
   counts.
2. Preserve the SQLite database and all raw rows.
3. Set `LOCAL_FIRST_ALL_GUILDS_ENABLED=false` and restore the previously
   verified explicit Guild lists.
4. Restart the Bot gracefully and reconcile the cutover boundary before any
   cleanup.

Do not delete local data or force legacy routing while unsynced Message Outbox
events exist. Git rollback can revert the finalization commit, while the
pre-rollout SQLite backup preserves operational data.

## Retention boundary

Local raw retention/cleanup is intentionally not implemented in this phase.
SQLite database, WAL, and raw row growth must be monitored; no automatic delete
is performed. The principal growth sources are message content and high-volume
Reaction/Voice/Member transitions. This is not a correctness blocker for the
projection pipeline, but it is an operational capacity risk and must be handled
as a separate, dry-run-first Local Raw Retention/Cleanup phase.

Reaction remove-all/remove-emoji gateway events and nickname-only member
changes are also not implemented by this phase; the existing add/remove and
join/leave/role-update analytics contract is unchanged.
