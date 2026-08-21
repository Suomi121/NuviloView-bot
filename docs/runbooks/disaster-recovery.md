# Disaster recovery runbook

This runbook is for NuviloView operators. It does not authorize production failover, destructive migration, secret rotation, deployment, or feature-flag activation. Record the incident time, affected service, host ID, commit SHA, and every operator action without copying secrets into tickets or chat.

## Common safety gate

Before recovery, confirm the affected Guilds and services, preserve logs and database evidence, identify the current lease owner, and verify a recent backup plus its checksum. Prefer stopping a conflicting process over starting another. Never run two production Bot instances without the distributed singleton being enabled and validated on every host.

## Bot crash or restart loop

- **Detect:** Discord presence is stale, external monitor reports heartbeat age, or the host runner shows repeated exits.
- **Contain:** Disable automatic restart if attempts are accelerating. Capture the sanitized final error, PID, host ID, and restart count.
- **Recover:** Fix configuration or dependency availability, validate once without Discord login where possible, then start one approved host.
- **Verify:** One Discord session, fresh heartbeat, stable PID, expected Guild count, no duplicate event writes.
- **Rollback:** Stop the new process and restore the last known-good build/config. Do not rotate the token unless exposure is suspected and rotation is separately approved.

## Android host lost

- **Detect:** Agent and Bot heartbeats are stale; Tailscale/Termux host is unreachable.
- **Contain:** Treat the host as unavailable, not stopped, until its lease expires or ownership is proved absent.
- **Recover:** Restore power/network, Termux wake lock, Agent, then Bot runner. Production transfer to Windows requires explicit failover approval.
- **Verify:** Host heartbeat and Agent process list recover; only one Bot lease owner exists.
- **Rollback:** Stop the recovered Android Bot if another approved owner is active.

## Windows failover

- **Prerequisite:** Explicit approval, same service key on all hosts, distributed singleton enabled and tested everywhere, expired/released old lease, and current backup.
- **Recover:** Start the approved Windows host once. Do not bypass lease acquisition or Session Start Limit backoff.
- **Verify:** New host owns the lease, fencing token advanced, Android is stopped/contended, Discord shows one session, analytics writes are singular.
- **Rollback:** Stop Windows, wait for lease release/expiry, then restore the previously approved host. Never force ownership by editing the lease row.

## Database outage

- **Detect:** DB connection failures across Web/Bot and monitor; distinguish Neon outage, network/DNS, expired credentials, and connection exhaustion.
- **Contain:** Stop write-heavy retry loops. Do not repeatedly run migrations or backups.
- **Recover:** Restore connectivity/provider service. Let normal bounded backoff reconnect. If data restoration is required, use an isolated database first and obtain approval before production cutover.
- **Verify:** Read-only health query, lease/heartbeat behavior, authentication, one analytics write path, and row-count sanity.
- **Rollback:** Revert connection configuration to the last known-good secret reference. Secret rotation requires separate approval.

## Discord outage or rate limit

- **Detect:** Gateway disconnects, REST 429/5xx, Discord status incident, or rising command failures.
- **Contain:** Keep standard discord.js rate-limit handling; do not add parallel retry or bypass delays.
- **Recover:** Allow bounded exponential backoff and Session Start Limit safeguards. Start no additional hosts.
- **Verify:** Gateway ready once, command response, heartbeat, and no event backlog storm.
- **Rollback:** Stop the restarted instance if reconnect churn resumes; preserve logs.

## Singleton stuck or split-brain warning

- **Detect:** Two fresh heartbeats, conflicting owner/host reports, lease loss loop, or duplicate Discord sessions.
- **Contain:** Stop the newer/non-owner process first. If ownership is unclear, stop all Bot hosts; do not edit/delete the lease.
- **Recover:** Inspect lease expiry, owner instance, fencing token, host heartbeats, and Discord sessions. Restart one approved host only after the lease is safely expired/released.
- **Verify:** Exactly one owner and one Discord session for at least two renewal intervals.
- **Rollback:** Stop the candidate host and return to a single known-good local runner.

## Backup failure or retry storm

- **Detect:** Repeated dump/archive creation, staging growth, transfer spike, or failed manifests.
- **Contain:** Stop the backup worker and disable its scheduler entry. Keep existing artifacts and application services unchanged.
- **Recover:** Correct the failed stage, exclude secret files, use one-shot execution, verify checksums and an isolated restore, then re-enable only after approval.
- **Verify:** No repeated artifacts during the observation window; F/G copies, manifest, encryption status, and restore verification agree.
- **Rollback:** Stop the worker again. Never delete the newest verified generations while investigating.

## Web deployment failure

- **Detect:** Vercel health/error spike, broken authentication/API/UI after a deployment.
- **Contain:** Stop further promotion. A deployment does not authorize DB rollback.
- **Recover:** Use Vercel's previous known-good deployment after explicit production-deploy approval, or fix through a reviewed PR.
- **Verify:** landing page, OAuth callback, dashboard authorization, Guild boundary, key APIs, and monitor.
- **Rollback:** Promote the previous deployment; retain the failed build and logs for diagnosis.

## Suspected secret leak

- **Detect:** token scanner finding, exposed archive/log, unauthorized login, or provider alert.
- **Contain:** Restrict access to the artifact and stop affected automation. Do not paste the value into logs or chat.
- **Recover:** Inventory scope and consumers, then rotate each affected secret only with explicit approval. Update hosts through their secret stores, not source control.
- **Verify:** old credential rejected, new credential works from intended hosts, repository/history scanner clean, audit trail complete.
- **Rollback:** Credential rotation normally cannot be rolled back safely; use a newly issued replacement if the new credential fails.

## Migration failure

- **Detect:** migration runner reports checksum mismatch, missing approval, lock conflict, SQL error, or post-check failure.
- **Contain:** Stop immediately. Do not mark the journal manually and do not run the legacy bootstrap.
- **Recover:** Preserve the transaction error and schema-drift report. Transactional migrations roll back automatically. For any non-transactional change, compare actual schema to the manifest and obtain a reviewed remediation plan.
- **Verify:** manifest checksum, migration journal, static and live drift checks, application build/tests, and critical read paths.
- **Rollback:** Use the migration's reviewed rollback procedure or restore an isolated backup. `DROP`, `TRUNCATE`, and destructive production rollback require separate authorization.

## Escalation record

Escalate when data loss is possible, ownership cannot be proved, a backup cannot be restored, secrets may be exposed, more than one Discord session exists, or recovery requires a prohibited operation. Record the decision owner and explicit approval before proceeding.
