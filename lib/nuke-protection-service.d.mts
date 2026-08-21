export function classifyAuditEntry(entry: Record<string, any>, guild: Record<string, any>): Record<string, any> | null
export function executeContainmentRoleRemovals(input: Record<string, any>): Promise<{
  status: 'failed' | 'partial' | 'contained'
  removedRoleIds: string[]
  failures: Array<{ roleId: string; error: string }>
}>
export function executeSecurityKick(input: Record<string, any>): Promise<{ kicked: boolean; error: string | null }>
export function createNukeProtectionService(input: Record<string, any>): {
  globallyEnabled: boolean
  diagnoseGuild(guild: Record<string, any>): Promise<Record<string, any>>
  handleAuditLogEntry(entry: Record<string, any>, guild: Record<string, any>): Promise<Record<string, any> | null>
  handleWebhookUpdate(channel: Record<string, any>): Promise<Record<string, any> | null>
  handleBotMessage(message: Record<string, any>): Promise<Record<string, any> | Record<string, any>[] | null>
  createSnapshotForGuild(guild: Record<string, any>, options?: Record<string, any>): Promise<Record<string, any>>
  ensureDailySnapshot(guild: Record<string, any>): Promise<Record<string, any> | null>
  pollActionRequests(): Promise<void>
  purgeExpiredSecurityData(): Promise<void>
  clearGuild(guildId: string): void
}
