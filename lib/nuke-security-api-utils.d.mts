export declare const SECURITY_SCOPES: Readonly<Record<string, string>>
export function isDiscordSnowflake(value: unknown): boolean
export function securityScopesForAccess(input: { managedGuild: boolean; guildOwner: boolean }): string[]
export function hasSecurityScope(scopes: string[], requiredScope: string): boolean
export function normalizeResolutionReason(value: unknown): string | null
export function normalizeTrustedActorInput(input: unknown): { actorId: string; actorType: string; label: string | null } | null
