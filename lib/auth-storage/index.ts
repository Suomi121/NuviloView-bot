import 'server-only'

import { pool as legacyNeonPool } from '@/lib/db'
import type { WebAuthStorage } from './contract'
import { createNeonLegacyAuthStorage } from './neon-legacy'
import { resolveWebAuthDatabaseConfig } from './provider-config'
import { createSupabaseAuthStorage } from './supabase'

const globalAuthStorage = globalThis as typeof globalThis & {
  nuviloWebAuthStorage?: WebAuthStorage
}

function createConfiguredStorage() {
  const config = resolveWebAuthDatabaseConfig()
  return config.provider === 'supabase'
    ? createSupabaseAuthStorage({
        connectionString: config.connectionString,
        caCertificate: config.caCertificate,
      })
    // Preserve the current shared Neon Pool when the feature flag is unset.
    // This avoids adding a second connection pool in the default path.
    : createNeonLegacyAuthStorage({ pool: legacyNeonPool })
}

export const authStorage = globalAuthStorage.nuviloWebAuthStorage ?? createConfiguredStorage()

if (process.env.NODE_ENV !== 'production') {
  globalAuthStorage.nuviloWebAuthStorage = authStorage
}

export const authPool = authStorage.pool
export type { WebAuthDbProvider, WebAuthStorage } from './contract'
export { resolveWebAuthDatabaseConfig } from './provider-config'
