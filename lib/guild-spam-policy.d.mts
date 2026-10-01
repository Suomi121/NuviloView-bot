export type SpamPreset = 'RELAXED' | 'NORMAL' | 'STRICT' | 'CUSTOM'
export type SpamAction = 'LOG_ONLY' | 'ALERT' | 'INCIDENT'
export type SpamPolicyMode = 'STRENGTH' | 'CUSTOM'
export type GuildSpamPolicy = {
  enabled: boolean
  strength: number | null
  mode: SpamPolicyMode
  preset: SpamPreset
  messageCountThreshold: number
  messageWindowSeconds: number
  duplicateCountThreshold: number
  duplicateWindowSeconds: number
  mentionCountThreshold: number
  mentionWindowSeconds: number
  linkCountThreshold: number
  linkWindowSeconds: number
  crossChannelThreshold: number
  crossChannelWindowSeconds: number
  messageBurstEnabled: boolean
  duplicateEnabled: boolean
  mentionEnabled: boolean
  linkEnabled: boolean
  crossChannelEnabled: boolean
  action: SpamAction
  ignoreBots: boolean
  ignoreAdmins: boolean
  ignoredRoleIds: string[]
  ignoredChannelIds: string[]
  updatedAt: string | Date | null
  updatedBy: string | null
}
export declare const SPAM_POLICY_PRESETS: readonly SpamPreset[]
export declare const SPAM_POLICY_ACTIONS: readonly SpamAction[]
export declare const SPAM_POLICY_MODES: readonly SpamPolicyMode[]
export declare const SPAM_POLICY_MODULES: readonly (keyof GuildSpamPolicy)[]
export declare const SPAM_POLICY_LIMITS: Readonly<{ thresholdMin: number; thresholdMax: number; windowMinSeconds: number; windowMaxSeconds: number; ignoredIdMax: number }>
export declare const GUILD_SPAM_POLICY_AUDIT_FIELDS: readonly (keyof GuildSpamPolicy)[]
export function spamProtectionLevel(strength: number): 'OFF' | 'RELAXED' | 'NORMAL' | 'STRICT'
export function strengthForSpamPreset(preset: SpamPreset): number | null
export function strengthToSpamPolicy(strength: number): Pick<GuildSpamPolicy, 'strength' | 'mode' | 'preset' | 'messageCountThreshold' | 'messageWindowSeconds' | 'duplicateCountThreshold' | 'duplicateWindowSeconds' | 'mentionCountThreshold' | 'mentionWindowSeconds' | 'linkCountThreshold' | 'linkWindowSeconds' | 'crossChannelThreshold' | 'crossChannelWindowSeconds'> | null
export function applySpamProtectionStrength(policy: GuildSpamPolicy, strength: number): GuildSpamPolicy | null
export function applySpamProtectionCommand(policy: GuildSpamPolicy, operation: 'on' | 'off' | 'level' | 'messages' | 'duplicate' | 'mentions' | 'links' | 'cross-channel', value?: boolean | number): GuildSpamPolicy | null
export function spamPolicyToDatabaseFields(policy: Partial<GuildSpamPolicy>, fields?: readonly (keyof GuildSpamPolicy)[]): Record<string, unknown> | null
export function isSpamProtectionActive(policy: GuildSpamPolicy | null): boolean
export declare const DEFAULT_GUILD_SPAM_POLICY: Readonly<GuildSpamPolicy>
export function canAccessGuildSpamPolicy(managedGuilds: Array<{ id: string }> | null | undefined, guildId: string): boolean
export function getSpamPolicyPreset(preset: Exclude<SpamPreset, 'CUSTOM'>): Readonly<Pick<GuildSpamPolicy, 'preset' | 'messageCountThreshold' | 'messageWindowSeconds' | 'duplicateCountThreshold' | 'duplicateWindowSeconds' | 'mentionCountThreshold' | 'mentionWindowSeconds' | 'linkCountThreshold' | 'linkWindowSeconds' | 'crossChannelThreshold' | 'crossChannelWindowSeconds'>>
export function getSpamPolicyPreset(preset: string): Readonly<Record<string, string | number>> | null
export function normalizeGuildSpamPolicy(input: unknown, options?: { allowCustom?: boolean }): GuildSpamPolicy | null
export function policyFromPreset(preset: SpamPreset, current?: GuildSpamPolicy): GuildSpamPolicy | null
export function withCustomPresetOnManualChange<K extends keyof GuildSpamPolicy>(policy: GuildSpamPolicy, key: K, value: GuildSpamPolicy[K]): GuildSpamPolicy
export function shouldApplyGuildSpamPolicy(options: { policy: GuildSpamPolicy | null; isBot?: boolean; isOwnBot?: boolean; isWebhook?: boolean; isAdmin?: boolean; roleIds?: string[]; channelId?: string }): { track: boolean; reason: string | null }
export function resolveSpamPolicyAction(options: { isCustom: boolean; policy?: GuildSpamPolicy | null; source?: 'guild' | 'default' | 'fallback' }): SpamAction | 'LEGACY_TIMEOUT'
export function getChangedSpamPolicyFields(previous: Partial<GuildSpamPolicy> | null, next: Partial<GuildSpamPolicy> | null): string[]
export function getSpamPolicyAuditChanges(previous: Partial<GuildSpamPolicy> | null, next: Partial<GuildSpamPolicy> | null): Record<string, { before: unknown; after: unknown }>
export function countSpamLinks(content: string): number
export function countSpamMentions(options?: { userCount?: number; roleCount?: number; everyone?: boolean }): number
export function parseGuildSpamPolicyRow(row: Record<string, unknown> | null): GuildSpamPolicy | null
export function createGuildSpamPolicyCache(options: { loadPolicy: (guildId: string) => Promise<GuildSpamPolicy | null>; ttlMs?: number; maxEntries?: number; now?: () => number; logger?: Pick<Console, 'warn'> }): { get(guildId: string): Promise<{ policy: GuildSpamPolicy | null; isCustom: boolean; source: 'guild' | 'default' | 'fallback' }>; invalidate(guildId?: string): void; readonly size: number }
export function createGuildSpamDetectionTracker(options?: { cooldownMs?: number }): { record(input: { guildId: string; userId: string; channelId: string; content: string; mentionCount?: number; linkCount?: number; policy: GuildSpamPolicy; timestamp?: number }): { detected: boolean; excluded: boolean; signals: string[]; count: number; coolingDown: boolean; cooldownUntil?: number | null }; prune(timestamp?: number): void; forgetGuild(guildId: string): void; forgetUser(guildId: string, userId: string): void; readonly trackedWindowCount: number; readonly cooldownCount: number }
