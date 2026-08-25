import type { WebAuthDbProvider } from './contract'

export type WebAuthDatabaseConfig = {
  provider: WebAuthDbProvider
  connectionString: string
  toJSON(): { provider: WebAuthDbProvider }
}

function requiredConnectionString(value: string | undefined, provider: WebAuthDbProvider) {
  const connectionString = value?.trim()
  if (!connectionString) {
    const variable = provider === 'supabase'
      ? 'WEB_AUTH_SUPABASE_DATABASE_URL (or SUPABASE_DATABASE_URL)'
      : 'DATABASE_URL'
    throw new Error(`Web Auth database is not configured for ${provider}; set ${variable}.`)
  }
  return connectionString
}

export function resolveWebAuthDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WebAuthDatabaseConfig {
  const rawProvider = environment.WEB_AUTH_DB_PROVIDER?.trim().toLowerCase() || 'neon'
  if (rawProvider !== 'neon' && rawProvider !== 'supabase') {
    throw new Error('WEB_AUTH_DB_PROVIDER must be either neon or supabase.')
  }

  const provider: WebAuthDbProvider = rawProvider
  const connectionString = requiredConnectionString(
    provider === 'supabase'
      ? environment.WEB_AUTH_SUPABASE_DATABASE_URL ?? environment.SUPABASE_DATABASE_URL
      : environment.DATABASE_URL,
    provider,
  )

  // Keep credentials non-enumerable so routine config logging cannot serialize
  // a PostgreSQL URL. The server-side adapter can still read the property.
  const config = {
    provider,
    toJSON: () => ({ provider }),
  } as WebAuthDatabaseConfig
  Object.defineProperty(config, 'connectionString', {
    value: connectionString,
    enumerable: false,
    writable: false,
  })
  return Object.freeze(config)
}
