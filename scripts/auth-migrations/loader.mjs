import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export async function loadAuthIdentityMigration() {
  const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'))
  const migration = manifest.migrations[0]
  if (manifest.scope !== 'web-auth-only' || manifest.migrations.length !== 1 ||
      migration.id !== '20260906-provider-identity-unique' ||
      migration.file !== migration.id + '.sql' || migration.manualApprovalRequired !== true) {
    throw new Error('Unexpected Auth migration manifest')
  }
  const sql = await readFile(new URL(migration.file, import.meta.url), 'utf8')
  const checksum = createHash('sha256').update(sql.replace(/\r\n?/g, '\n')).digest('hex')
  if (checksum !== migration.checksum) throw new Error('Auth migration checksum mismatch')
  return { ...migration, sql }
}
