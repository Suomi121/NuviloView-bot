# Google Identity Phase 0.5 — Production readiness checklist

Last reviewed: 2026-09-04

## Architecture and scope

- NuviloView Web authentication is provided by Better Auth.
- Auth records are stored in PostgreSQL through the selected Web Auth adapter. The current Supabase option is PostgreSQL storage; this implementation does **not** use Supabase Auth or the Supabase Google provider.
- Google is an additional sign-in identity. It does not replace Discord Guild authorization.
- Google scopes are limited to `openid`, `email`, and `profile`.
- Discord scopes remain `identify` and `guilds`; the Discord email scope is not requested.
- Account linking is an explicit action on `/account`. Matching email addresses are not implicitly merged.
- `/pro` is a presentation shell only. There is no billing, checkout, subscription, or entitlement implementation.

## Stable callback URLs

Google OAuth redirect URIs must match exactly, including the scheme, host, path, and trailing slash.

| Environment | Authorized redirect URI |
| --- | --- |
| Local development | `http://localhost:3000/api/auth/callback/google` |
| Preview canary | `https://nuviloview-auth-canary-iafqfvwjiujpngkmfcay.vercel.app/api/auth/callback/google` |
| Production (future approval only) | `https://nuviloview-oem.vercel.app/api/auth/callback/google` |

Use the stable Preview canary hostname for real OAuth tests. Do not register generated deployment URLs as long-lived OAuth callbacks, and do not configure a wildcard redirect URI.

## Google Cloud Console checklist (manual)

1. Select the Google Cloud project dedicated to NuviloView.
2. Configure the OAuth consent screen with NuviloView's public home page, privacy policy, terms, and an operator contact address.
3. Add only domains controlled by the operator as authorized domains.
4. Create a Web application OAuth client.
5. Register the exact Local and Preview redirect URIs above. Register the Production URI only as part of an approved Production rollout.
6. Confirm the requested scopes are only `openid`, `email`, and `profile`.
7. During testing mode, add only the intended test accounts.
8. Never paste the client secret into source code, GitHub, a browser-visible variable, screenshots, or logs.

## Vercel Preview checklist (manual secret entry)

Set the following as server-only **Preview** variables. Do not use the `NEXT_PUBLIC_` prefix.

- `NUVILOVIEW_GOOGLE_CLIENT_ID`
- `NUVILOVIEW_GOOGLE_CLIENT_SECRET`
- `BETTER_AUTH_URL=https://nuviloview-auth-canary-iafqfvwjiujpngkmfcay.vercel.app`
- Include the same stable canary origin in `BETTER_AUTH_TRUSTED_ORIGINS`.

Keep Production variables unchanged until a separate Production approval. After changing Preview variables, create a new Preview deployment so that the deployment receives them.

The selected Web Auth PostgreSQL database must already contain the existing Better Auth schema. No Google-specific account table or Supabase Auth setting is required.

## Required real OAuth matrix

Run these tests only against the stable Preview canary and an isolated test identity set.

| Case | Expected result |
| --- | --- |
| A. New Google-only sign-in | Callback succeeds; user lands on `/account`; Discord connection is shown as missing; no Guild data is returned. |
| B. Existing Discord user links Google | Explicit action on `/account` succeeds; one NuviloView user retains both provider connections and existing Guild access. |
| C. Existing Google user links Discord | Explicit action succeeds; Discord Guild authorization becomes available only after Discord is linked. |
| D. Same Google identity attempted from a different user | Link is rejected as already linked; users and sessions are not merged. |
| E. Cancel/deny or invalid callback | User returns to `/auth-error`; no credential or raw provider error is exposed. |
| F. Logout then re-login with each provider | Session is invalidated on logout; each linked provider signs back into the intended NuviloView user. |
| G. External/encoded callback path | Sign-in uses the provider default (`/account` for Google, `/dashboard` for Discord); no external redirect occurs. |

For every case, verify that logs contain no OAuth code, access token, refresh token, ID token, client secret, database URL, or email beyond what is needed in the authenticated UI.

## Current Phase 0.5 gate

Automated security and regression checks can be completed without credentials. Real OAuth remains pending until the two Google Preview variables and the Google Cloud Preview redirect are configured manually. Production must not be enabled or deployed as part of Phase 0.5.
