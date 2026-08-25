import type { Pool } from 'pg'
import { createPostgresAuthStorage } from './postgres'

export function createNeonLegacyAuthStorage(options: { connectionString?: string; pool?: Pool }) {
  return createPostgresAuthStorage({ provider: 'neon', ...options })
}
