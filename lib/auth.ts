import { betterAuth } from "better-auth"
import { pool } from "@/lib/db"

const discordClientId = process.env.NUVILOVIEW_CLIENT_ID ?? process.env.DISCORD_CLIENT_ID
const discordClientSecret = process.env.NUVILOVIEW_CLIENT_SECRET ?? process.env.DISCORD_CLIENT_SECRET

const baseURL =
  process.env.BETTER_AUTH_URL ??
  (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : undefined)

const additionalTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

export const auth = betterAuth({
  database: pool,
  baseURL,
  // Discord OAuth is the primary sign-in method for NuviloView:OEM.
  // Better Auth 1.x requires a non-null email-shaped identity key even when a
  // provider does not return an email. We therefore disable Discord's default
  // `email` scope and generate a non-deliverable local identifier instead of
  // collecting or storing the user's real Discord email address.
  socialProviders: {
    discord: {
      clientId: discordClientId as string,
      clientSecret: discordClientSecret as string,
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
})
