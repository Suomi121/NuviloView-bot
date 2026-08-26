import type { Pool } from 'pg'

export type WebAuthDbProvider = 'neon' | 'supabase'

export type DiscordAuthUserInput = {
  userId: string
  discordUserId: string
  accountId?: string
  name: string
  email: string
  emailVerified?: boolean
  image?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  accessTokenExpiresAt?: Date | null
  refreshTokenExpiresAt?: Date | null
  scope?: string | null
}

export type AuthUserRecord = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  createdAt: Date
  updatedAt: Date
}

export type AuthSessionInput = {
  id: string
  token: string
  userId: string
  expiresAt: Date
  ipAddress?: string | null
  userAgent?: string | null
}

export type AuthSessionRecord = AuthSessionInput & {
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  updatedAt: Date
}

export type UserPreference = {
  timeZone: string
  language: 'ja' | 'en'
}

export type StoredGuildTheme = {
  mode: string
  primaryColor: string
  accentColor: string
  backgroundColor: string
  cardColor: string
  radius: string
  brandName: string
  logoUrl: string | null
}

export type DiscordOAuthAccount = {
  id: string
  accountId: string
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: Date | string | null
}

export type ManagedGuildCache = {
  guilds: unknown
  updatedAt: Date | string
}

export type AuthStorageHealthStatus = {
  provider: WebAuthDbProvider
  status: 'UNKNOWN' | 'HEALTHY' | 'UNAVAILABLE'
  lastCheckedAt: string | null
  lastSuccessfulAt: string | null
  lastFailureCode: string | null
}

export interface WebAuthStorage {
  readonly provider: WebAuthDbProvider
  readonly pool: Pool
  readonly users: {
    upsertDiscordUser(input: DiscordAuthUserInput): Promise<AuthUserRecord>
    getByDiscordId(discordUserId: string): Promise<AuthUserRecord | null>
  }
  readonly sessions: {
    create(input: AuthSessionInput): Promise<AuthSessionRecord>
    get(token: string): Promise<AuthSessionRecord | null>
    delete(token: string): Promise<boolean>
  }
  readonly settings: {
    getPreference(userId: string): Promise<UserPreference | null>
    upsertPreference(userId: string, preference: UserPreference): Promise<UserPreference>
    getGuildTheme(userId: string, guildId: string): Promise<StoredGuildTheme | null>
    upsertGuildTheme(userId: string, guildId: string, theme: StoredGuildTheme): Promise<StoredGuildTheme>
    deleteGuildTheme(userId: string, guildId: string): Promise<boolean>
  }
  readonly guildAccess: {
    getDiscordAccount(userId: string): Promise<DiscordOAuthAccount | null>
    getDiscordUserId(userId: string): Promise<string | null>
    updateDiscordTokens(
      accountId: string,
      accessToken: string,
      refreshToken: string | null,
      accessTokenExpiresAt: Date,
    ): Promise<void>
    getManagedGuildCache(userId: string): Promise<ManagedGuildCache | null>
    setManagedGuildCache(userId: string, guilds: unknown): Promise<void>
  }
  readonly rateLimit: {
    isLimited(input: {
      scope: string
      identity: string
      limit: number
      windowSeconds: number
    }): Promise<boolean>
  }
  readonly health: {
    getStatus(): AuthStorageHealthStatus
    check(options?: { force?: boolean }): Promise<AuthStorageHealthStatus>
    recordSuccess(): void
    recordFailure(error: unknown): void
  }
  close(): Promise<void>
}
