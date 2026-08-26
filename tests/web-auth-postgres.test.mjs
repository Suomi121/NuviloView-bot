import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'

import { createPostgresAuthStorage } from '../lib/auth-storage/postgres.ts'
import { resolveWebAuthDatabaseConfig } from '../lib/auth-storage/provider-config.ts'

const testDatabaseUrl = process.env.TEST_WEB_AUTH_DATABASE_URL?.trim()
const testDatabaseCa = process.env.TEST_WEB_AUTH_DATABASE_CA_CERT?.trim()

if (!testDatabaseUrl) {
  test('Web Auth PostgreSQL integration (set TEST_WEB_AUTH_DATABASE_URL)', { skip: true }, () => {})
} else {
  const storage = createPostgresAuthStorage({
    provider: 'supabase',
    connectionString: testDatabaseUrl,
    caCertificate: testDatabaseCa,
  })
  const pool = storage.pool
  const userId = 'web-auth-test-user'
  const discordUserId = '123456789012345678'
  const guildId = '223456789012345678'

  before(async () => {
    const schema = await readFile(new URL('../docs/sql/web-auth-supabase-v1.sql', import.meta.url), 'utf8')
    await pool.query(schema)
    await pool.query(`
      TRUNCATE TABLE "guild_theme", "user_preference", "discord_managed_guild_cache",
        "api_rate_limit", "verification", "session", "account", "user" CASCADE
    `)
  })

  after(async () => {
    await pool.query(`
      TRUNCATE TABLE "guild_theme", "user_preference", "discord_managed_guild_cache",
        "api_rate_limit", "verification", "session", "account", "user" CASCADE
    `).catch(() => undefined)
    await storage.close()
  })

  test('OAuth user create, existing login and Discord ID lookup are idempotent', async () => {
    const first = await storage.users.upsertDiscordUser({
      userId,
      discordUserId,
      name: 'Canary User',
      email: `discord-${discordUserId}@users.invalid`,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      scope: 'identify guilds',
    })
    assert.equal(first.id, userId)

    const second = await storage.users.upsertDiscordUser({
      userId,
      discordUserId,
      name: 'Updated Canary User',
      email: `discord-${discordUserId}@users.invalid`,
      accessToken: 'updated-test-access-token',
    })
    assert.equal(second.name, 'Updated Canary User')
    assert.equal((await storage.users.getByDiscordId(discordUserId))?.id, userId)
    assert.equal((await storage.guildAccess.getDiscordUserId(userId)), discordUserId)
  })

  test('session create, read, expiry, delete and logout behavior', async () => {
    const active = await storage.sessions.create({
      id: 'session-active',
      token: 'session-token-active',
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    })
    assert.equal(active.userId, userId)
    assert.equal((await storage.sessions.get(active.token))?.id, active.id)

    await storage.sessions.create({
      id: 'session-expired',
      token: 'session-token-expired',
      userId,
      expiresAt: new Date(Date.now() - 60_000),
    })
    assert.equal(await storage.sessions.get('session-token-expired'), null)
    assert.equal(await storage.sessions.get('invalid-session'), null)
    assert.equal(await storage.sessions.delete(active.token), true)
    assert.equal(await storage.sessions.get(active.token), null)
  })

  test('user settings and Guild-scoped theme round trip', async () => {
    assert.equal(await storage.settings.getPreference(userId), null)
    assert.deepEqual(await storage.settings.upsertPreference(userId, {
      timeZone: 'Asia/Tokyo',
      language: 'ja',
    }), { timeZone: 'Asia/Tokyo', language: 'ja' })

    const theme = {
      mode: 'dark',
      primaryColor: '#6677ff',
      accentColor: '#9b8cff',
      backgroundColor: '#111116',
      cardColor: '#1c1c24',
      radius: 'default',
      brandName: 'NuviloView:OEM',
      logoUrl: null,
    }
    assert.deepEqual(await storage.settings.upsertGuildTheme(userId, guildId, theme), theme)
    assert.deepEqual(await storage.settings.getGuildTheme(userId, guildId), theme)
    assert.equal(await storage.settings.deleteGuildTheme(userId, guildId), true)
    assert.equal(await storage.settings.getGuildTheme(userId, guildId), null)
  })

  test('Guild access cache and OAuth token update use only selected storage', async () => {
    const guilds = [{ id: guildId, name: 'Canary Guild', icon: null }]
    await storage.guildAccess.setManagedGuildCache(userId, guilds)
    assert.deepEqual((await storage.guildAccess.getManagedGuildCache(userId))?.guilds, guilds)

    const account = await storage.guildAccess.getDiscordAccount(userId)
    assert.equal(account?.accountId, discordUserId)
    await storage.guildAccess.updateDiscordTokens(
      account.id,
      'refreshed-access-token',
      'refreshed-refresh-token',
      new Date(Date.now() + 120_000),
    )
    assert.equal((await storage.guildAccess.getDiscordAccount(userId))?.accessToken, 'refreshed-access-token')
    assert.equal(await storage.rateLimit.isLimited({
      scope: 'guild-list', identity: userId, limit: 1, windowSeconds: 60,
    }), false)
    assert.equal(await storage.rateLimit.isLimited({
      scope: 'guild-list', identity: userId, limit: 1, windowSeconds: 60,
    }), true)
  })

  test('Supabase-selected adapter remains usable with Neon offline', async () => {
    const config = resolveWebAuthDatabaseConfig({
      WEB_AUTH_DB_PROVIDER: 'supabase',
      WEB_AUTH_SUPABASE_DATABASE_URL: testDatabaseUrl,
      DATABASE_URL: 'postgresql://127.0.0.1:1/neon-offline',
    })
    assert.equal(config.provider, 'supabase')
    assert.equal((await storage.health.check({ force: true })).status, 'HEALTHY')
    assert.equal((await storage.users.getByDiscordId(discordUserId))?.id, userId)
  })
}
