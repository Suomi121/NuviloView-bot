import { betterAuth } from "better-auth"
import { authStorage } from "@/lib/auth-storage"
import { isAuthStorageUnavailableError, safeAuthStorageErrorCode } from "@/lib/auth-storage/postgres"
import { authProviderCredentials, getAuthProviderAvailability } from "@/lib/auth-provider-config"

const baseURL =
  process.env.BETTER_AUTH_URL ??
  (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : undefined)

const additionalTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const providerAvailability = getAuthProviderAvailability()

export const auth = betterAuth({
  database: authStorage.pool,
  baseURL,
  // Discord OAuth is the primary sign-in method for NuviloView:OEM.
  // Better Auth 1.x requires a non-null email-shaped identity key even when a
  // provider does not return an email. We therefore disable Discord's default
  // `email` scope and generate a non-deliverable local identifier instead of
  // collecting or storing the user's real Discord email address.
  socialProviders: {
    discord: {
      clientId: authProviderCredentials.discord.clientId as string,
      clientSecret: authProviderCredentials.discord.clientSecret as string,
      disableDefaultScope: true,
      scope: ["identify", "guilds"],
      // Refresh the stored Discord display name and avatar whenever the user
      // signs in, so profile changes are reflected in the dashboard.
      overrideUserInfoOnSignIn: true,
      mapProfileToUser: (profile) => ({
        email: `discord-${profile.id}@users.invalid`,
        emailVerified: false,
      }),
    },
    ...(providerAvailability.google ? {
      google: {
        clientId: authProviderCredentials.google.clientId as string,
        clientSecret: authProviderCredentials.google.clientSecret as string,
        // NuviloView uses Google only for authentication. No Drive, Gmail or
        // other Google service scope is requested.
        scope: ["openid", "email", "profile"],
      },
    } : {}),
  },
  account: {
    accountLinking: {
      enabled: true,
      // Linking is an explicit action on /account. A matching provider email
      // must never silently merge two NuviloView users.
      disableImplicitLinking: true,
      trustedProviders: ["discord", "google"],
      // Discord deliberately uses a users.invalid identity key, so an
      // authenticated user must be allowed to link a real Google address.
      allowDifferentEmails: true,
      updateUserInfoOnLink: false,
      allowUnlinkingAll: false,
    },
  },
  trustedOrigins: [
    ...(baseURL ? [baseURL] : []),
    ...additionalTrustedOrigins,
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  advanced: {
    // HTTPS-only session cookies are required outside local development.
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
  onAPIError: {
    // OAuth callback failures land on a small, non-sensitive recovery page.
    // Better Auth still owns state, nonce, CSRF and redirect validation.
    errorURL: '/auth-error',
    onError: (error) => {
      if (isAuthStorageUnavailableError(error)) authStorage.health.recordFailure(error)
      // Log only the selected provider and a bounded driver code. Database
      // URLs, OAuth tokens and raw PostgreSQL error details are never logged.
      console.error(`[web-auth] request failed provider=${authStorage.provider} code=${safeAuthStorageErrorCode(error)}`)
    },
  },
})
