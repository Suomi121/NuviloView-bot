import { betterAuth } from "better-auth"
import { pool } from "@/lib/db"

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
  // The `identify` + `guilds` scopes let us read the user's profile and the
  // list of servers they belong to (including their permission level).
  socialProviders: {
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID as string,
      clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
      scope: ["identify", "email", "guilds"],
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
