# NuviloView Nuke Protection v2 Incident Handoff — 2026-08-22

## Production Incident overview

Nuke Protection v2 produced false-positive incidents from legitimate Discord administrative activity. The highest false positive reached Critical 100 after unrelated Webhook actions were mixed into one actor window. Incident and risk history was preserved; no incident rows were deleted or rewritten.

## PHASE 1 — Emergency mitigation

- Existing global switch `NUVILOVIEW_NUKE_PROTECTION` was changed to `false` on the Windows Bot host and in Vercel Production.
- Windows Bot was restarted so the disabled flag took effect.
- All 13 Guild policies were confirmed with Auto Containment OFF and Auto Restore OFF.
- All 13 policy status rows were set to Disabled for accurate UI reporting.
- Thirteen `EmergencyMitigationApplied` audit events were written.
- At verification time: new incidents in 15 minutes = 0, containment in 15 minutes = 0, restore in 15 minutes = 0, connected Guilds = 13.
- Existing incidents, risk evidence, snapshots, Analytics, normal Discord audit collection, Message History Import, Reaction Roles, Health and heartbeat were retained.

## PHASE 2 — Root cause

1. A legitimate Bot was not in Trusted Actors; two Webhook creates crossed the one-hour detector threshold.
2. Later Webhook deletes were correlated into the typed `WEBHOOK_NUKE` incident using only Guild, actor and time.
3. Risk recalculation selected every action for the Guild and actor, not only the current incident.
4. This mixed 12 actions, added 60 burst points and produced raw risk 160 / Critical 100.
5. Audit-entry deduplication worked: duplicate Audit Log ID groups = 0.
6. Guild Owner risk was suppressed to zero, but concurrent events could still create separate incidents.
7. Correlation confidence was not represented, so delayed/unknown correlation had no Critical safety gate.

## PHASE 3 — Implemented changes

- Added explicit per-Guild `off | shadow | active` mode without replacing the legacy response policy.
- Global OFF overrides Guild mode and existing policy.
- OFF fast-path runs before classification, trusted-actor lookup, risk scoring, incidents and alerts.
- OFF also blocks Bot-spam tracking, snapshots, containment, queued actions and restore previews.
- Policy cache refresh is bounded to two seconds by default; test configuration can disable caching.
- SHADOW permits detection/evidence but blocks containment and restore.
- ACTIVE retains existing response-policy and independent Auto Containment/Auto Restore gates.
- Saved automatic-action settings are not deleted when switching to OFF or SHADOW.
- Risk queries are incident-bound, and legacy events only correlate with legacy incidents.
- Same-actor processing is serialized in the Bot to prevent concurrent incident-creation races.
- Medium-confidence correlation cannot become Critical; low-confidence/unknown actor risk cannot cross the suspicious threshold.
- Guild Owner, NuviloView self, Trusted Actors and managed integration actors are suppressed before incident creation.
- Security policy API validates modes, preserves Guild isolation, supports Guild administrators and Platform Developers server-side, and records `NUKE_PROTECTION_MODE_CHANGED`.
- Security UI shows Off/Shadow/Active, confirmations and disabled automatic controls.
- Developer Console shows every Guild mode and Global Kill Switch state.

## Validation results

- Tests: 254 / 254 passed.
- Managed migrations: 9 ordered migrations, checksums valid.
- TypeScript: passed.
- Production build: passed locally and on Vercel.
- JavaScript syntax: 76 modules passed.
- Secret scan: passed; no potential Discord tokens outside ignored secret files.
- Lint: 0 errors, 12 existing warnings.

## Production state at checkpoint

- Global Kill Switch: **OFF**. Do not re-enable during checkpoint recovery.
- Auto Containment: 0 enabled Guilds.
- Auto Restore: 0 enabled Guilds.
- Database migration `20260822-nuke-protection-mode`: **already applied** before the stop instruction arrived.
- Production DB migration journal/checks: 9/9 applied and valid.
- Existing 13 Guild rows migrated to `shadow`; Global OFF makes their effective mode OFF.
- Windows Bot: **already restarted with the new code** before the stop instruction arrived; last observed PID was 15312.
- Vercel Production: **already deployed and aliased** before cancellation completed.
- Vercel deployment ID: `dpl_DuFRxhVDf5utWaPiaRWk7EGJFvYi`.
- Production URL remained `https://nuviloview-oem.vercel.app`.
- No further Production verification or mutation was performed after the stop instruction.

The requested statements “DB additive migration未実施”, “Vercel再Deploy未実施”, and “Bot新コード再起動未実施” are not true for this checkpoint because those operations finished immediately before the stop instruction. This document records the actual state to prevent unsafe re-execution.

## Git checkpoint

- Branch: `hotfix/nuke-protection-v2-emergency-off-20260822`
- Base before checkpoint commit: `7d0afe2`
- PHASE 3 implementation commit SHA: `5097d20df05ac9cf1a12aca1af72778bf6aa21dc`.
- Final checkpoint commit SHA: use `git rev-parse HEAD` after this HANDOFF commit.
- Working tree: expected clean after commit.
- Push: expected to `origin/hotfix/nuke-protection-v2-emergency-off-20260822` if the push succeeds.
- main merge, tag and GitHub Release: not performed.

## Rollback

1. Keep `NUVILOVIEW_NUKE_PROTECTION=false` throughout rollback.
2. Roll Vercel back to the deployment preceding `dpl_DuFRxhVDf5utWaPiaRWk7EGJFvYi`.
3. Restore the Windows Bot source to commit `7d0afe2` and restart only in an explicitly authorized release window.
4. The additive `nukeProtectionMode` column may safely remain; old code ignores it.
5. Do not run the down migration while incident evidence or the new UI/API may still depend on the column.

## Next-session resume point

Start with one read-only production verification: confirm Global OFF, Bot heartbeat/Guild count, Vercel deployment identity, and that incident/containment/restore counters have not increased. Do not enable Nuke Protection until that verification and an explicit authorization are complete.
