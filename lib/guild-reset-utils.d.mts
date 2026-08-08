export class GuildResetError extends Error {
  code: string
  publicMessage: string
  details: unknown
  constructor(code: string, publicMessage: string, details?: unknown)
}

export function isDiscordId(value: unknown): value is string
export function parseIdList(value: unknown): string[]
export function parseDeveloperIds(environment?: NodeJS.ProcessEnv): Set<string>
export function isResetDeveloper(userId: string, environment?: NodeJS.ProcessEnv): boolean
export function getGuildResetConfig(environment?: NodeJS.ProcessEnv): {
  enabled: boolean
  maxChannelDeletes: number
  maxRoleDeletes: number
  maxTotalOperations: number
  guildCooldownHours: number
  developerCooldownMinutes: number
  planExpiresMinutes: number
  codeExpiresMinutes: number
  backupDirectory: string
  globalConcurrency: number
  lockExpiresMinutes: number
}
export function normalizeResetOptions(input?: Record<string, unknown>): {
  mode: 'channels_only' | 'channels_and_roles' | 'settings_reset'
  dryRun: boolean
  deleteChannels: boolean
  deleteRoles: boolean
  resetSettings: boolean
  createDefaultChannels: boolean
  keepChannelIds: string[]
  keepRoleIds: string[]
  reason: string
}
export function stableStringify(value: unknown): string
export function hashGuildSnapshot(value: unknown): string
export function createSnapshotFingerprint(snapshot: Record<string, any>): Record<string, unknown>
export function getConfirmationSecret(environment?: NodeJS.ProcessEnv): string | null
export function generateConfirmationCode(): string
export function hashConfirmationCode(input: {
  code: string
  planId: string
  guildId: string
  developerId: string
  secret: string
}): string
export function verifyConfirmationCode(input: {
  code: string
  codeHash: string
  planId: string
  guildId: string
  developerId: string
  secret: string
}): boolean
export function getLimitState(
  summary: Record<string, unknown>,
  limits: Record<string, number>,
): { exceeded: boolean; reasons: string[] }
export function getCooldownRemaining(input: {
  lastStartedAt: string | Date | null
  durationMilliseconds: number
  dryRun?: boolean
  operationStarted?: boolean
  now?: number
}): number
export function assertLockAvailable(acquired: boolean, message?: string): true
export function isExpired(value: string | Date, now?: number): boolean
export function assertPlanUsable(
  plan: Record<string, any> | null,
  input: { guildId: string; developerId: string; now?: number },
): true
export function assertConfirmationUsable(
  confirmation: Record<string, any> | null,
  input: {
    planId: string
    guildId: string
    developerId: string
    requestId?: string | null
    now?: number
  },
): true
export function assertSnapshotMatches(plannedHash: string, currentHash: string): true
export function assertTargetsNotProtected(
  targetIds: string[],
  protectedIds: string[],
  targetType: string,
): true
export function orderChannelTargets(targets: Array<Record<string, any>>): Array<Record<string, any>>
export function orderRoleTargets(targets: Array<Record<string, any>>): Array<Record<string, any>>
export function buildDryRunItems(
  targetSummary: Record<string, any>,
  options: Record<string, any>,
): Array<Record<string, any>>
export function buildBackupDocument(input: Record<string, any>): Record<string, any>
export function requireBackupBeforeMutation<T>(
  createBackup: () => Promise<any>,
  mutation: (backup: any) => Promise<T>,
): Promise<T>
export function runWithRelease<T>(
  work: () => Promise<T>,
  release: () => Promise<void>,
): Promise<T>
export function assertDeveloperGuildAccess(input: Record<string, unknown>): true
export function selectResetTargets(input: Record<string, any>): Record<string, any>
export function summarizeExecutionItems(items: Array<{ status: string }>): {
  successCount: number
  failedCount: number
  skippedCount: number
}
