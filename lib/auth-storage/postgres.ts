import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
import type {
  AuthSessionInput,
  AuthSessionRecord,
  AuthStorageHealthStatus,
  AuthUserRecord,
  DiscordAuthUserInput,
  DiscordOAuthAccount,
  ManagedGuildCache,
  StoredGuildTheme,
  UserPreference,
  WebAuthDbProvider,
  WebAuthStorage,
} from './contract'

type Queryable = Pick<Pool | PoolClient, 'query'>

const healthProbeIntervalMs = 30_000
const connectionStringSslParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']

function createPoolConfig(connectionString: string, caCertificate?: string): PoolConfig {
  const config: PoolConfig = {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  }
  if (!caCertificate) return config

  // node-postgres replaces an explicit `ssl` object when SSL query parameters
  // are also present in the connection string. Remove only those conflicting
  // parameters, then verify the Supabase hostname against its published CA.
  const parsed = new URL(connectionString)
  for (const parameter of connectionStringSslParameters) {
    parsed.searchParams.delete(parameter)
  }
  return {
    ...config,
    connectionString: parsed.toString(),
    ssl: {
      ca: caCertificate,
      rejectUnauthorized: true,
    },
  }
}

export function safeAuthStorageErrorCode(error: unknown) {
  const value = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  return /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : 'AUTH_STORAGE_ERROR'
}

export function isAuthStorageUnavailableError(error: unknown) {
  const code = safeAuthStorageErrorCode(error)
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
    /^[0-9A-Z]{5}$/.test(code)
}

function createHealthMonitor(pool: Pool, provider: WebAuthDbProvider) {
  let status: AuthStorageHealthStatus['status'] = 'UNKNOWN'
  let lastCheckedAt: Date | null = null
  let lastSuccessfulAt: Date | null = null
  let lastFailureCode: string | null = null

  const snapshot = (): AuthStorageHealthStatus => ({
    provider,
    status,
    lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
    lastSuccessfulAt: lastSuccessfulAt?.toISOString() ?? null,
    lastFailureCode,
  })

  const recordSuccess = () => {
    const now = new Date()
    status = 'HEALTHY'
    lastCheckedAt = now
    lastSuccessfulAt = now
    lastFailureCode = null
  }

  const recordFailure = (error: unknown) => {
    status = 'UNAVAILABLE'
    lastCheckedAt = new Date()
    lastFailureCode = safeAuthStorageErrorCode(error)
  }

  return {
    getStatus: snapshot,
    recordSuccess,
    recordFailure,
    async check({ force = false }: { force?: boolean } = {}) {
      if (!force && lastCheckedAt && Date.now() - lastCheckedAt.getTime() < healthProbeIntervalMs) {
        return snapshot()
      }
      try {
        await pool.query('SELECT 1 AS ok')
        recordSuccess()
      } catch (error) {
        recordFailure(error)
      }
      return snapshot()
    },
  }
}

async function query<Row extends QueryResultRow>(
  client: Queryable,
  health: ReturnType<typeof createHealthMonitor>,
  text: string,
  values: unknown[] = [],
) {
  try {
    const result = await client.query<Row>(text, values)
    health.recordSuccess()
    return result
  } catch (error) {
    health.recordFailure(error)
    throw error
  }
}

export function createPostgresAuthStorage({
  provider,
  connectionString,
  caCertificate,
  pool: suppliedPool,
}: {
  provider: WebAuthDbProvider
  connectionString?: string
  caCertificate?: string
  pool?: Pool
}): WebAuthStorage {
  if (!suppliedPool && !connectionString) {
    throw new Error(`A ${provider} Web Auth database connection is required.`)
  }

  const ownsPool = !suppliedPool
  const pool = suppliedPool ?? new Pool(createPoolConfig(connectionString as string, caCertificate))
  const health = createHealthMonitor(pool, provider)
  pool.on('error', (error) => health.recordFailure(error))

  const users = {
    async upsertDiscordUser(input: DiscordAuthUserInput) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const userResult = await query<AuthUserRecord>(client, health, `
          INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, now(), now())
          ON CONFLICT ("id") DO UPDATE SET
            "name" = EXCLUDED."name",
            "email" = EXCLUDED."email",
            "emailVerified" = EXCLUDED."emailVerified",
            "image" = EXCLUDED."image",
            "updatedAt" = now()
          RETURNING "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"
        `, [
          input.userId,
          input.name,
          input.email,
          input.emailVerified ?? false,
          input.image ?? null,
        ])

        const existingAccount = await query<{ id: string }>(client, health, `
          SELECT "id" FROM "account"
          WHERE "providerId" = 'discord' AND "accountId" = $1
          ORDER BY "createdAt" ASC LIMIT 1
        `, [input.discordUserId])
        const accountId = existingAccount.rows[0]?.id ?? input.accountId ?? randomUUID()
        await query(client, health, `
          INSERT INTO "account" (
            "id", "accountId", "providerId", "userId", "accessToken", "refreshToken",
            "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "createdAt", "updatedAt"
          ) VALUES ($1, $2, 'discord', $3, $4, $5, $6, $7, $8, now(), now())
          ON CONFLICT ("id") DO UPDATE SET
            "accountId" = EXCLUDED."accountId",
            "providerId" = 'discord',
            "userId" = EXCLUDED."userId",
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = COALESCE(EXCLUDED."refreshToken", "account"."refreshToken"),
            "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt",
            "refreshTokenExpiresAt" = EXCLUDED."refreshTokenExpiresAt",
            "scope" = EXCLUDED."scope",
            "updatedAt" = now()
        `, [
          accountId,
          input.discordUserId,
          input.userId,
          input.accessToken ?? null,
          input.refreshToken ?? null,
          input.accessTokenExpiresAt ?? null,
          input.refreshTokenExpiresAt ?? null,
          input.scope ?? null,
        ])
        await client.query('COMMIT')
        return userResult.rows[0]
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async getByDiscordId(discordUserId: string) {
      const result = await query<AuthUserRecord>(pool, health, `
        SELECT u."id", u."name", u."email", u."emailVerified", u."image", u."createdAt", u."updatedAt"
        FROM "user" u
        INNER JOIN "account" a ON a."userId" = u."id"
        WHERE a."providerId" = 'discord' AND a."accountId" = $1
        ORDER BY a."createdAt" DESC LIMIT 1
      `, [discordUserId])
      return result.rows[0] ?? null
    },
  }

  const sessions = {
    async create(input: AuthSessionInput) {
      const result = await query<AuthSessionRecord>(pool, health, `
        INSERT INTO "session" (
          "id", "token", "userId", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
        ON CONFLICT ("id") DO UPDATE SET
          "token" = EXCLUDED."token",
          "userId" = EXCLUDED."userId",
          "expiresAt" = EXCLUDED."expiresAt",
          "ipAddress" = EXCLUDED."ipAddress",
          "userAgent" = EXCLUDED."userAgent",
          "updatedAt" = now()
        RETURNING "id", "token", "userId", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
      `, [input.id, input.token, input.userId, input.expiresAt, input.ipAddress ?? null, input.userAgent ?? null])
      return result.rows[0]
    },

    async get(token: string) {
      const result = await query<AuthSessionRecord>(pool, health, `
        SELECT "id", "token", "userId", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
        FROM "session" WHERE "token" = $1 LIMIT 1
      `, [token])
      const session = result.rows[0]
      // The legacy Better Auth schema uses timestamp-without-time-zone. Let pg
      // normalize it to a Date before expiry comparison so Windows/JST tests
      // and Vercel/UTC behave identically.
      return session && new Date(session.expiresAt).getTime() > Date.now() ? session : null
    },

    async delete(token: string) {
      const result = await query(pool, health, 'DELETE FROM "session" WHERE "token" = $1', [token])
      return (result.rowCount ?? 0) > 0
    },
  }

  const settings = {
    async getPreference(userId: string) {
      const result = await query<UserPreference>(pool, health,
        'SELECT "timeZone", "language" FROM "user_preference" WHERE "userId" = $1', [userId])
      return result.rows[0] ?? null
    },

    async upsertPreference(userId: string, preference: UserPreference) {
      const result = await query<UserPreference>(pool, health, `
        INSERT INTO "user_preference" ("userId", "timeZone", "language", "updatedAt")
        VALUES ($1, $2, $3, now())
        ON CONFLICT ("userId") DO UPDATE SET
          "timeZone" = EXCLUDED."timeZone", "language" = EXCLUDED."language", "updatedAt" = now()
        RETURNING "timeZone", "language"
      `, [userId, preference.timeZone, preference.language])
      return result.rows[0]
    },

    async getGuildTheme(userId: string, guildId: string) {
      const result = await query<StoredGuildTheme>(pool, health, `
        SELECT "mode", "primaryColor", "accentColor", "backgroundColor", "cardColor",
               "radius", "brandName", "logoUrl"
        FROM "guild_theme" WHERE "userId" = $1 AND "guildId" = $2
      `, [userId, guildId])
      return result.rows[0] ?? null
    },

    async upsertGuildTheme(userId: string, guildId: string, theme: StoredGuildTheme) {
      const result = await query<StoredGuildTheme>(pool, health, `
        INSERT INTO "guild_theme" (
          "userId", "guildId", "mode", "primaryColor", "accentColor", "backgroundColor",
          "cardColor", "radius", "brandName", "logoUrl", "updatedAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
        ON CONFLICT ("userId", "guildId") DO UPDATE SET
          "mode"=EXCLUDED."mode", "primaryColor"=EXCLUDED."primaryColor",
          "accentColor"=EXCLUDED."accentColor", "backgroundColor"=EXCLUDED."backgroundColor",
          "cardColor"=EXCLUDED."cardColor", "radius"=EXCLUDED."radius",
          "brandName"=EXCLUDED."brandName", "logoUrl"=EXCLUDED."logoUrl", "updatedAt"=now()
        RETURNING "mode", "primaryColor", "accentColor", "backgroundColor", "cardColor",
                  "radius", "brandName", "logoUrl"
      `, [userId, guildId, theme.mode, theme.primaryColor, theme.accentColor, theme.backgroundColor,
        theme.cardColor, theme.radius, theme.brandName, theme.logoUrl])
      return result.rows[0]
    },

    async deleteGuildTheme(userId: string, guildId: string) {
      const result = await query(pool, health,
        'DELETE FROM "guild_theme" WHERE "userId" = $1 AND "guildId" = $2', [userId, guildId])
      return (result.rowCount ?? 0) > 0
    },
  }

  const guildAccess = {
    async getDiscordAccount(userId: string) {
      const result = await query<DiscordOAuthAccount>(pool, health, `
        SELECT "id", "accountId", "accessToken", "refreshToken", "accessTokenExpiresAt"
        FROM "account"
        WHERE "userId" = $1 AND "providerId" = 'discord'
        ORDER BY "createdAt" DESC LIMIT 1
      `, [userId])
      return result.rows[0] ?? null
    },

    async getDiscordUserId(userId: string) {
      const result = await query<{ accountId: string }>(pool, health, `
        SELECT "accountId" FROM "account"
        WHERE "userId" = $1 AND "providerId" = 'discord'
        ORDER BY "createdAt" DESC LIMIT 1
      `, [userId])
      return result.rows[0]?.accountId ?? null
    },

    async updateDiscordTokens(
      accountId: string,
      accessToken: string,
      refreshToken: string | null,
      accessTokenExpiresAt: Date,
    ) {
      await query(pool, health, `
        UPDATE "account" SET
          "accessToken" = $1,
          "refreshToken" = COALESCE($2, "refreshToken"),
          "accessTokenExpiresAt" = $3,
          "updatedAt" = now()
        WHERE "id" = $4
      `, [accessToken, refreshToken, accessTokenExpiresAt, accountId])
    },

    async getManagedGuildCache(userId: string) {
      const result = await query<ManagedGuildCache>(pool, health,
        'SELECT "guilds", "updatedAt" FROM "discord_managed_guild_cache" WHERE "userId" = $1', [userId])
      return result.rows[0] ?? null
    },

    async setManagedGuildCache(userId: string, guilds: unknown) {
      await query(pool, health, `
        INSERT INTO "discord_managed_guild_cache" ("userId", "guilds", "updatedAt")
        VALUES ($1, $2::jsonb, now())
        ON CONFLICT ("userId") DO UPDATE SET "guilds" = EXCLUDED."guilds", "updatedAt" = now()
      `, [userId, JSON.stringify(guilds)])
    },
  }

  const rateLimit = {
    async isLimited({
      scope,
      identity,
      limit,
      windowSeconds,
    }: {
      scope: string
      identity: string
      limit: number
      windowSeconds: number
    }) {
      const secret = process.env.BETTER_AUTH_SECRET ?? 'local-development-rate-limit-key'
      const identityHash = createHash('sha256').update(`${secret}:${identity}`).digest('hex')
      const bucketMilliseconds = windowSeconds * 1000
      const bucketStart = new Date(Math.floor(Date.now() / bucketMilliseconds) * bucketMilliseconds)
      const key = `${scope}:${identityHash}`
      const result = await query(pool, health, `
        INSERT INTO "api_rate_limit" ("key", "bucketStart", "count")
        VALUES ($1, $2, 1)
        ON CONFLICT ("key", "bucketStart") DO UPDATE
        SET "count" = "api_rate_limit"."count" + 1
        WHERE "api_rate_limit"."count" < $3
        RETURNING "count"
      `, [key, bucketStart, limit])
      return result.rowCount === 0
    },
  }

  return {
    provider,
    pool,
    users,
    sessions,
    settings,
    guildAccess,
    rateLimit,
    health,
    async close() {
      if (ownsPool) await pool.end()
    },
  }
}
