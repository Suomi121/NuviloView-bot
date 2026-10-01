import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { loadAuthIdentityMigration } from './auth-migrations/loader.mjs'

// Deliberately no DATABASE_URL / Production fallback and no legacy migration set.
const migration = await loadAuthIdentityMigration()
const connectionString = process.env.AUTH_MIGRATION_DATABASE_URL
if (!connectionString) throw new Error('An explicit AUTH_MIGRATION_DATABASE_URL is required')
let target
try {
  target = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(target.protocol)) throw new Error()
} catch {
  // URL parser errors can include the input credential. Do not retain the cause.
  throw new Error('Invalid Auth migration connection configuration')
}
const fingerprint = createHash('sha256')
  .update([target.hostname, target.port || '5432', target.pathname, target.username].join('|'))
  .digest('hex')
const execute = process.argv.includes('--execute')
if (execute && (!process.argv.includes('--approve=' + migration.id) ||
    !process.argv.includes('--expect-fingerprint=' + fingerprint))) {
  throw new Error('Execution requires migration approval and the fingerprint from the read-only plan')
}
const client = new pg.Client({ connectionString, application_name: 'nuviloview-auth-identity-migration' })
try {
  await client.connect()
  await client.query('BEGIN READ ONLY')
  const audit = await client.query(await readFile(new URL('./auth-migrations/duplicate-audit.sql', import.meta.url), 'utf8'))
  await client.query('COMMIT')
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'read-only', fingerprint, migration: migration.id, ...audit.rows[0] }))
  if (audit.rows[0].duplicate_groups !== 0) throw new Error('Duplicate repair requires separate review')
  if (execute) {
    await client.query(migration.sql)
    console.log('Auth identity migration applied; ownership uniqueness verified')
  }
} catch (error) {
  // SQL detail can include provider subjects: report only a bounded code.
  console.error(JSON.stringify({ status: 'failed', code: /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : 'AUTH_MIGRATION_FAILED' }))
  process.exitCode = 1
} finally {
  await client.end()
}
