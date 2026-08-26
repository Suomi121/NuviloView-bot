import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  resolveWebAuthDatabaseConfig,
} from '../lib/auth-storage/provider-config.ts'
import {
  createPostgresAuthStorage,
  isAuthStorageUnavailableError,
  safeAuthStorageErrorCode,
} from '../lib/auth-storage/postgres.ts'

test('Web Auth provider defaults to the legacy Neon connection', () => {
  const config = resolveWebAuthDatabaseConfig({ DATABASE_URL: 'postgresql://legacy-secret' })
  assert.equal(config.provider, 'neon')
  assert.equal(config.connectionString, 'postgresql://legacy-secret')
  assert.deepEqual(JSON.parse(JSON.stringify(config)), { provider: 'neon' })
  assert.doesNotMatch(JSON.stringify(config), /legacy-secret/)
})

test('Supabase selection never falls back to DATABASE_URL', () => {
  assert.throws(() => resolveWebAuthDatabaseConfig({
    WEB_AUTH_DB_PROVIDER: 'supabase',
    DATABASE_URL: 'postgresql://neon-must-not-be-used',
  }), /WEB_AUTH_SUPABASE_DATABASE_URL/)

  const config = resolveWebAuthDatabaseConfig({
    WEB_AUTH_DB_PROVIDER: 'supabase',
    DATABASE_URL: 'postgresql://neon-must-not-be-used',
    WEB_AUTH_SUPABASE_DATABASE_URL: 'postgresql://supabase-only',
    WEB_AUTH_SUPABASE_CA_CERT: 'supabase-public-ca',
  })
  assert.equal(config.provider, 'supabase')
  assert.equal(config.connectionString, 'postgresql://supabase-only')
  assert.equal(config.caCertificate, 'supabase-public-ca')
  assert.doesNotMatch(JSON.stringify(config), /supabase-public-ca/)
})

test('Supabase can intentionally reuse its server-side replica URL', () => {
  const config = resolveWebAuthDatabaseConfig({
    WEB_AUTH_DB_PROVIDER: 'supabase',
    SUPABASE_DATABASE_URL: 'postgresql://shared-supabase',
  })
  assert.equal(config.connectionString, 'postgresql://shared-supabase')
  assert.doesNotMatch(JSON.stringify(config), /shared-supabase/)
})

test('invalid provider is rejected instead of silently choosing a database', () => {
  assert.throws(() => resolveWebAuthDatabaseConfig({
    WEB_AUTH_DB_PROVIDER: 'turso',
    DATABASE_URL: 'postgresql://legacy',
  }), /either neon or supabase/)
})

test('Auth health is cached and exposes only a bounded error code', async () => {
  let calls = 0
  const fakePool = {
    on() {},
    async query() {
      calls += 1
      if (calls === 1) return { rows: [{ ok: 1 }], rowCount: 1 }
      throw Object.assign(new Error('postgresql://secret-value'), { code: 'ECONNREFUSED' })
    },
  }
  const storage = createPostgresAuthStorage({ provider: 'supabase', pool: fakePool })
  assert.equal((await storage.health.check({ force: true })).status, 'HEALTHY')
  assert.equal((await storage.health.check()).status, 'HEALTHY')
  assert.equal(calls, 1)
  const failed = await storage.health.check({ force: true })
  assert.equal(failed.status, 'UNAVAILABLE')
  assert.equal(failed.lastFailureCode, 'ECONNREFUSED')
  assert.doesNotMatch(JSON.stringify(failed), /secret-value/)
  assert.equal(isAuthStorageUnavailableError(Object.assign(new Error(), { code: '57P03' })), true)
  assert.equal(safeAuthStorageErrorCode(new Error('secret')), 'AUTH_STORAGE_ERROR')
})

test('Supabase query failure is explicit and never writes to a Neon fallback', async () => {
  let supabaseQueries = 0
  let neonQueries = 0
  const failingSupabasePool = {
    on() {},
    async query() {
      supabaseQueries += 1
      throw Object.assign(new Error('unavailable'), { code: '57P03' })
    },
  }
  const unusedNeonPool = {
    async query() { neonQueries += 1 },
  }
  const storage = createPostgresAuthStorage({ provider: 'supabase', pool: failingSupabasePool })
  await assert.rejects(() => storage.sessions.get('session-token'), { code: '57P03' })
  assert.equal(supabaseQueries, 1)
  assert.equal(neonQueries, 0)
  assert.equal(storage.health.getStatus().status, 'UNAVAILABLE')
  assert.equal(storage.provider, 'supabase')
  assert.ok(unusedNeonPool)
})

test('active Web Auth paths use authStorage and keep Turso out of auth', async () => {
  const files = await Promise.all([
    readFile(new URL('../lib/auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../lib/discord.ts', import.meta.url), 'utf8'),
    readFile(new URL('../lib/developer-access.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/guilds/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/settings/timezone/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/settings/theme/route.ts', import.meta.url), 'utf8'),
  ])
  for (const source of files) {
    assert.match(source, /authStorage/)
    assert.doesNotMatch(source, /TURSO_AUTH_TOKEN|TURSO_DATABASE_URL/)
  }
  assert.match(files[0], /database:\s*authStorage\.pool/)
  assert.doesNotMatch(files[0], /from ["']@\/lib\/db["']/)
  assert.doesNotMatch(files[1], /from ["']@\/lib\/db["']/)
  assert.doesNotMatch(files[2], /from ["']@\/lib\/db["']/)
  assert.doesNotMatch(files[3], /from ["']@\/lib\/db["']/)
  assert.doesNotMatch(files[4], /from ["']@\/lib\/db["']/)
  assert.doesNotMatch(files[5], /from ["']@\/lib\/db["']/)
})

test('Supabase bootstrap contains only reviewed Web Auth and route-security tables', async () => {
  const sql = await readFile(new URL('../docs/sql/web-auth-supabase-v1.sql', import.meta.url), 'utf8')
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(tables, [
    'user',
    'session',
    'account',
    'verification',
    'discord_managed_guild_cache',
    'user_preference',
    'guild_theme',
    'api_rate_limit',
  ])
  assert.doesNotMatch(sql, /discord_message|daily_stats|voice_session|reaction_event/i)
  assert.match(sql, /REVOKE ALL ON TABLE/)
})

test('OAuth security settings and friendly unavailable UX remain present', async () => {
  const authSource = await readFile(new URL('../lib/auth.ts', import.meta.url), 'utf8')
  const loginButton = await readFile(new URL('../components/login-button.tsx', import.meta.url), 'utf8')
  const errorPage = await readFile(new URL('../app/auth-error/page.tsx', import.meta.url), 'utf8')
  assert.match(authSource, /scope:\s*\["identify", "guilds"\]/)
  assert.match(authSource, /trustedOrigins/)
  assert.match(authSource, /useSecureCookies/)
  assert.match(authSource, /errorURL:\s*'\/auth-error'/)
  assert.match(loginButton, /errorCallbackURL:\s*'\/auth-error'/)
  assert.match(loginButton, /result\.error/)
  assert.match(loginButton, /router\.push\('\/auth-error'\)/)
  assert.match(errorPage, /ログインサービスが一時的に利用できません/)
  assert.doesNotMatch(errorPage, /DATABASE_URL|connectionString|stack|error\.message/)
})
