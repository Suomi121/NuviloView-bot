# Security operator roles (PR-A)

## Dependency and baseline

Implementation baseline: `8ca6c1abc554845eb87e77b5771f9eaf5be1e3bf`
(`feat/security-v2-all-guilds`, draft PR #34), on PR #33's Reset retirement.
Main at investigation: `92d4b17eee90656e46db8617820602d2c508c0a3`.
Do not merge or deploy this feature independently of those dependencies.

## Commands and authority

`/adsetroll add role`, `remove role`, `list`, `status` require a freshly
verified Guild owner or Discord Administrator. Manage Guild alone is denied.
Up to 20 ordinary, manageable roles may be registered per Guild by ID.
Everyone, managed/integration roles and foreign/deleted roles are denied.
Role membership and role existence are fetched again when authorizing access.
Database or Discord failures deny delegated operator access.

Registered operators are intended solely for incident viewing and reporting.
They do not gain policy editing, Auto Timeout, log destination editing,
role management, kick, ban or timeout authority. This PR exposes the reusable
authorization function; incident/report consumers are separate dependent PRs.

## Storage and rollout

The existing Bot/Web PostgreSQL configuration path owns the additive
`guild_security_operator` and `guild_security_operator_audit` tables.
Role mutation and its audit use one atomic SQL statement. Concurrent changes
serialize on the Guild row; a failed audit prevents the role mutation.
The migration is forward-only, checksummed and requires manual approval.
There is no migration execution, command registration or runtime restart here.
No Auth DB, Worker, Supervisor, detection thresholds or timeout consent change.

Registration uses the existing extended command list without removing commands.
Existing definitions inspected: help, stc, tactive, permissions, suc, week,
spamprotection, dashboard, privacy, translate, zx, setroll, NuviloChan 翻訳,
commandupdate, cmup, botservers, diagnostics, guildblock, guildunblock,
guildblocks and the conditional dev-reset commands. Definition presence is
not a claim that every command is registered in Production.

## Remaining dependent work

- PR-B: dedicated timeout log destination and durable incident/log outcomes.
- PR-C: permission-gated evidence and false-positive TXT reporting buttons.
- PR-D: utility commands, split by risk and function.

The supplied reference image informs section layout and timestamp presentation,
not copied branding or public evidence attachments. No existing developer-report
channel has been confirmed; delivery must remain disabled until explicitly
configured, never guessed or redirected to arbitrary channels.
