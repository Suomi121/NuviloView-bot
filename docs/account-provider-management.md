# Account Connections / Provider Management

Implementation review: 2026-09-14. Branch: `feat/account-provider-management`.
Base: `204fe9209b8cc13b1e72fa22a900052e59ba0c77`.

## Scope and behavior

- Discord is labelled Primary / メイン; Google Secondary / サブ. These are display roles, not new ownership columns or a new authentication architecture.
- Better Auth **1.6.25** official `authClient.unlinkAccount({ providerId })` is used. Its fresh-session and account ownership checks remain in effect. `allowUnlinkingAll: false`, explicit linking, disabled email auto-link and existing provider-identity UNIQUE remain unchanged.
- Both unlink actions require a native modal confirmation. Discord warns about losing Guild access while retaining Google login. Cancel is initially focused; modal focus confinement/Escape are native. In-flight operations disable controls and use a synchronous ref against duplicate submission. Success re-lists accounts then replaces `/account`; errors use fixed safe copy.
- Last supported login method is also checked server-side immediately before Better Auth deletes the account. A nonblocking per-user PostgreSQL advisory lock serializes unlink across instances; concurrent operations receive conflict instead of waiting with pool connections. No UI/manual SQL deletes and no migration are added. Failed lock release destroys the connection rather than leaking a held lock back into the pool.
- Google provider `prompt: "select_account"` is supported by the installed provider implementation and therefore applies to both login and link authorization URLs. No Google logout or cookie removal.

## Guild cache safety

Unlink exposed an existing cached-permissions hazard: `getManagedGuilds` could return a user-scoped cached list before checking whether Discord remained linked.

The function now checks the current Discord account first. Cache JSON is bound to the exact local account-link ID, as are coalesced requests; pre-existing unbound arrays are discarded/refetched once. This prevents a different re-linked Discord identity inheriting the old list. A slow fetch checks the link again and only writes an envelope for its original link. A later caller will reject an old envelope even if the old request completed late.

The Discord owner/manage-Guild permission rule, scopes and each API's authorization gate are unchanged. The cache uses the existing JSON column, not a new table/schema migration. A transient cache miss can require one extra Discord read.

## Display profile and avatar

- Authenticated `/api/account-profile` calls Better Auth's official account info API with the current user's own account IDs, selects Discord, then Google, then the Better Auth user fallback. Only name/image are returned, with `private, no-store`; tokens and raw provider profiles are not returned.
- Account and Dashboard request this presentation data once per mounted user; there is no timer/polling and requests are aborted on unmount. This is never an authorization source.
- If provider profile reads fail, the fallback remains visible. A fresh remote profile cannot be guaranteed while that provider is unavailable; this does not grant Guild access.
- Google picture was blocked by CSP. Only `https://lh3.googleusercontent.com` was added to `img-src`; no broad wildcard or auth CSP relaxation. Existing plain `img` rendering needs no Next image optimizer/remotePatterns change.
- Image load failure renders initials; a changed URL can load again. No broken-image icon is left visible.

## Verification

- Full suite at implementation checkpoint: **459 total / 450 PASS / 9 SKIP / 0 FAIL**.
- Two additional UI/guard cases added afterwards: targeted management suite **7/7 PASS** (confirmation/cancel/double-click/refresh, last-provider UI disable, lock-contention/last-provider guard, actual provider chooser URL, profile priority, image failure and CSP).
- Actual repository Better Auth + disposable local PostgreSQL integration after cache hardening: **41/41 PASS**, including both unlink/relink directions, same user, last-provider rejection, cached-Guild denial, concurrent cross-provider unlink, identity races x2/x10/x100 and existing session isolation. No Cloud endpoint was contacted. Isolated PostgreSQL stopped gracefully.
- TypeScript PASS. Build PASS with process-local, nonfunctional loopback DB settings only. Initial build without required DB configuration failed closed; no Production credentials were pulled. The build does not constitute real OAuth verification.
- Full lint: 0 errors / 8 warnings (same total as base; avatar `img` warning moved into reusable component).
- Syntax: 161 modules PASS. Legacy/Auth migration checksums 9 + 1 PASS. Token leak scan PASS. Diff whitespace PASS.

## Production boundary / remaining checks

No Production deploy, environment edits, migration, live unlink/relink, DB repair, Bot/Worker restart or Termux change performed for this task. Existing unrelated investigation documents were preserved.

Real Google account-picker rendering, real provider avatar loading, and live unlink/relink smoke are **not tested with this new code**. They require a separately controlled Preview or approved deployment and a user-selected account. Prior Production identity collision remains unresolved; this feature does not automatically merge accounts or release another user's provider identity.

Implementation tests are passing; do not interpret this as a completed Production identity foundation GO.
