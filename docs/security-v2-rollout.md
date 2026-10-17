# Security Engine v2: all-Guild consent cutover (approval required)

Status: implementation candidate, NOT a Production rollout authorization.
Supersedes the legacy-compatibility decision in earlier Spam Policy plans.

## State and authority

All Guilds, including missing policy rows and new Guilds, use v2 permission
semantics. Missing is OFF, not legacy eligibility. Existing detection policy,
strength, modules and exclusions are unchanged. No custom detection row retains
the configured default message-rate detection, but NEVER grants punishment.
Detection remains independent of auto timeout. Saved `action` only chooses
non-punitive handling when automatic timeout is not authorized.

- Enrollment absent: `unmigrated`, OFF.
- Enrollment `pending`: migration seeded the inventory, OFF.
- Enrollment `complete`: Bot discovery/authorized command completed enrollment;
  the separate auto row defaults to false.
- Auto row absent/invalid or failed DB read: OFF. Enrollment survives separately.
- A missing previously configured detection row also denies punishment: enrollment
  retains a sticky detection-policy marker, supplemented by the retained policy
  audit for later official saves. Neither restart nor absence clears this marker.
  A Guild that has never configured detection may explicitly opt in with the
  default detector; losing an existing configuration is not treated as that case.
- Explicit `/spamprotection auto on|off` stores a boolean and audit atomically.
  OFF never deletes settings. Startup enrollment never overwrites consent.
- Global `security_v2_control.emergency_stop` starts TRUE; missing control is STOP.
- Bot `SECURITY_V2_AUTO_EXECUTION` must equal `enabled` to permit execution.
  Unset/other value is STOP. This is independent of detection enablement.
- Runtime reads consent without a cache and rechecks before the Discord call.
  DB failure or missing/partial schema suppresses punishment, not a legacy fallback.
- Timeout is 24h, subject to existing protected-member, hierarchy and audit guards.

DB setting updates serialize on the consent row; each committed update has a
unique revision and atomic audit. A failed write must not be reported as success.
Failed OFF cannot guarantee revocation of a previously committed ON: use emergency
controls until storage is healthy. An already dispatched Discord request cannot
be recalled by an OFF, and an existing timeout is not automatically removed.

Web GET returns the same consent state as Discord. PATCH accepts only explicit
`operation: on|off`, with existing session, Discord Guild management, same-origin,
JSON, and rate-limit gates. Ordinary detection PUT cannot change consent.
Dashboard displays consent and points to the explicit Discord commands; it does
not expose a reset. Retired DELETE is 410 and performs no write.

## Migration and inventory

`20261017-security-v2-consent.sql` is additive, transactional, checksum-managed,
manual-approval-required. It creates only separate v2 tables/index; it seeds
existing policy Guilds as pending without changing any detection row. No bulk ON.
Run using the established shared Bot/Web DB runner, NEVER the Auth-only DB.
The runner may apply other pending migrations: inspect the plan before approval.

The approved Bot cutover enumerates **the entire Discord Guild cache**, not only
policy rows, enrolling sequentially; `guildCreate` enrolls new Guilds. Failed
enrollment stays unmigrated/pending and OFF. Verify the live Guild inventory
against enrollment before declaring migration complete, including Guilds with no
policy. Partial inventory progress is safely retryable on startup. No public API
allows clients to claim another Guild or set migration completion directly.

## Required staged release — no actions executed in this implementation

1. Record Bot/Web/Worker versions and health; take/restore-verify shared-DB backup.
   Inventory every running instance and rollback artifact. Review PR/CI and plan.
2. **Contain old punishment BEFORE DB migration.** Old Bot ignores v2 control.
   Stop old Bot gracefully OR remove its Discord Moderate Members permission and
   verify effective permissions across all Guilds. `SPAM_PROTECTION_ENABLED=false`
   on an old instance requires a controlled restart and pauses detection too.
   DB migration alone, new environment variables alone, or Web deploy alone is NOT
   a safe cutover. Keep old instance contained throughout rollback.
3. With separate approval, apply the one new migration; keep global emergency
   stop TRUE. No old table alteration; old reads/writes remain structurally valid
   but old Bot must remain contained because it has unsafe legacy semantics.
4. Deploy reviewed Web and safe separate Bot placement preserving env/SQLite/WAL,
   queues/state/logs. Ensure singleton; do not unnecessarily restart Worker.
   Keep Bot execution switch unset. Sync command definitions only after approval;
   remove reset while preserving unrelated commands. Inspect all-Guild enrollment.
5. Verify detection + all default OFF, explicit OFF restart, error paths and audit
   using isolated tests first. Real test Guild only with separate approval; no
   real spam or punishment induction. Restore any authorized test setting.
6. Only after inventory, guards and operations review, separately authorize lifting
   emergency stop and setting Bot execution switch. No Guild is automatically ON;
   each administrator must explicitly choose ON. Observe errors/queues/permissions.

## Emergency stop and rollback

For v2: set global stop TRUE via approved operator transaction (not a Guild API),
verify fresh reads; if DB unreachable, remove Discord Moderate Members or stop
Bot. The local execution switch is read from the process environment and requires
controlled restart to change externally. Keep detection active where practical.
An in-flight request may finish; inspect Discord audit, do not promise cancellation.

Rollback uses a prior **v2-guarded** artifact with stop retained. NEVER restart an
uncontained legacy Bot as rollback. If only legacy artifact is available, retain
Discord permission containment or keep Bot stopped. Do not DROP v2 tables or
delete consent/audit; no reverse migration or mass timeout removal. Web may roll
back structurally but an old UI/DELETE route must not be re-exposed. Worker and
Auth need no changes.

## Release gate

Production remains untouched. CI/local tests cannot prove the actual production
Guild inventory, old-process containment, Discord effective permissions or operator
backup restoration. These are mandatory live preflight checks under future approval.
