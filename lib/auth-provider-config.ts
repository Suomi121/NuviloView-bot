import 'server-only'

const discordClientId = process.env.NUVILOVIEW_CLIENT_ID ?? process.env.DISCORD_CLIENT_ID
const discordClientSecret = process.env.NUVILOVIEW_CLIENT_SECRET ?? process.env.DISCORD_CLIENT_SECRET
const googleClientId = process.env.NUVILOVIEW_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID
const googleClientSecret = process.env.NUVILOVIEW_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET

export const authProviderCredentials = {
  discord: {
    clientId: discordClientId,
    clientSecret: discordClientSecret,
  },
  google: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
  },
} as const

export function getAuthProviderAvailability() {
  return {
    discord: Boolean(discordClientId && discordClientSecret),
    google: Boolean(googleClientId && googleClientSecret),
  }
}
