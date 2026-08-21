# Data retention and bounded cleanup

NuviloView uses explicit, table-specific retention windows. Cleanup is disabled by default: `npm run retention:plan` performs bounded read-only counts, while `npm run retention:execute` deletes at most 250 rows per policy and run. Production execution requires a reviewed maintenance window and operator approval.

| Policy | Data | Retention | Safety exclusions |
| --- | --- | ---: | --- |
| api-rate-limit | API throttle buckets | 7 days | None after expiry |
| recent-activity | Privacy-conscious activity feed | 90 days | None after expiry |
| discord-message | Searchable message content | 90 days | None after expiry |
| message-import-job | Completed import jobs and cascading channel checkpoints | 90 days | Queued, preparing, running, pausing, paused, cancelling, and stalled jobs |
| message-import-audit | Count-only import lifecycle audit events | 90 days | None after expiry |
| service-heartbeat | Runtime history | 30 days | Running rows and the current unexpired lease owner |
| moderation-audit | Moderation audit trail | 365 days | Pending operations |
| daily-active-member | Daily activity facts | 400 days | None after expiry |
| voice-session | Member voice sessions | 400 days | Open sessions |
| voice-server-session | Server voice sessions | 400 days | Open sessions |
| guild-member-event | Join/leave events | 400 days | None after expiry |
| reaction-event | Reaction facts | 400 days | None after expiry |

Security incidents, security evidence, Guild Reset plans/executions/backups, support requests, account records, and aggregate health history are not automatically deleted. Their legal, audit, restore, or product requirements must be approved before a retention rule is introduced.

## Operating contract

- The runner accepts only reviewed policy IDs and a batch size from 1 to 1,000.
- Every policy requires its supporting index before execution.
- A PostgreSQL advisory lock prevents concurrent cleanup runs.
- Each policy executes in its own short transaction with lock and statement timeouts.
- A failure stops the run; it does not loop or automatically retry.
- No `DROP`, `TRUNCATE`, table-wide delete, or cascading cleanup is used.

Before production execution, apply the separately approved retention-index migration, take and verify a backup, run the plan, record candidate counts, and start with one policy and a small batch. Rollback of a committed deletion requires restoring the affected rows from a verified backup; therefore execution is an explicit operator action, never part of application startup.
