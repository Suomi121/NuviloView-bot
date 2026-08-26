import type { Pool } from 'pg'
import { createPostgresAuthStorage } from './postgres'

export function createSupabaseAuthStorage(options: {
  connectionString?: string
  caCertificate?: string
  pool?: Pool
}) {
  return createPostgresAuthStorage({ provider: 'supabase', ...options })
}
