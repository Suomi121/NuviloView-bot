import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { isProviderIdentityConflict, PROVIDER_IDENTITY_CONSTRAINT } from '../lib/auth-provider-identity.ts'
import { loadAuthIdentityMigration } from '../scripts/auth-migrations/loader.mjs'

test('only the exact provider ownership unique violation becomes an identity conflict', () => {
  const conflict = { code: '23505', constraint: PROVIDER_IDENTITY_CONSTRAINT, table: 'account' }
  assert.equal(isProviderIdentityConflict(conflict), true)
  assert.equal(isProviderIdentityConflict({ cause: conflict }), true)
  for (const error of [
    null, '23505', { code: '23505', constraint: 'user_email_unique' },
    { ...conflict, code: '23503' }, { ...conflict, table: 'user' },
    { message: '23505 account_provider_identity_unique' },
    { code: 'ECONNRESET' }, { code: '53000' },
  ]) assert.equal(isProviderIdentityConflict(error), false)
  const circular = {}; circular.cause = circular
  assert.equal(isProviderIdentityConflict(circular), false)
})

test('Auth migration is immutable-checked, additive and independent of the legacy migration set', async () => {
  const migration = await loadAuthIdentityMigration()
  assert.match(migration.sql, /UNIQUE \("providerId", "accountId"\)/)
  assert.doesNotMatch(migration.sql, /UNIQUE[^;]*"userId"/)
  assert.match(migration.sql, /attnotnull/)
  assert.match(migration.sql, /LOCK TABLE public.account/)
  assert.match(migration.sql, /duplicate_groups > 0/)
  assert.match(migration.sql, /NOT c.condeferrable/)
  assert.doesNotMatch(migration.sql, /DELETE FROM|TRUNCATE|DROP TABLE|DROP COLUMN/i)
})

test('identity conflict uses a fixed recovery destination and safe allowlisted UI copy', async () => {
  const hook = await readFile(new URL('../lib/auth-provider-identity.ts', import.meta.url), 'utf8')
  const auth = await readFile(new URL('../lib/auth.ts', import.meta.url), 'utf8')
  const page = await readFile(new URL('../app/auth-error/page.tsx', import.meta.url), 'utf8')
  assert.match(auth, /hooks: \{ before: providerIdentityConflictHook \}/)
  assert.match(hook, /if \(!isProviderIdentityConflict\(error\)\) throw error/)
  assert.match(hook, /ctx.redirect\(`\/auth-error\?provider=\$\{ctx\.params\?\.id\}&error=account_already_linked_to_different_user`\)/)
  assert.match(page, /このDiscordアカウントには既存のNuviloViewアカウントがあります/)
  assert.match(page, /error === 'account_already_linked_to_different_user'/)
  assert.doesNotMatch(page, /23505|constraint|stack|error\.message|dangerouslySetInnerHTML/)
})
