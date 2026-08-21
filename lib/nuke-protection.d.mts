export type NukeAction = {
  guildId: string
  actorId: string | null
  actionType: string
  riskWeight?: number
  destructive?: boolean
  occurredAt: string | Date
}
export declare const NUKE_PROTECTION_SCHEMA_VERSION: number
export declare const SECURITY_INCIDENT_STATUSES: readonly string[]
export declare const DEFAULT_RISK_WEIGHTS: Readonly<Record<string, number>>
export declare const DEFAULT_SEVERITY_THRESHOLDS: Readonly<Record<string, number>>
export declare const SENSITIVITY_THRESHOLDS: Readonly<Record<string, Readonly<Record<string, number>>>>
export declare const DEFAULT_TIME_WINDOWS_MS: readonly number[]
export declare const DEFAULT_BURST_RULES: readonly Record<string, unknown>[]
export declare const DEFAULT_NUKE_PROTECTION_POLICY: Readonly<Record<string, unknown>>
export declare const DESTRUCTIVE_ACTION_TYPES: Set<string>
export function normalizeNukeProtectionPolicy(input?: Record<string, unknown>): Record<string, any>
export function severityForRisk(riskScore: number, thresholds?: Record<string, number>): string
export function calculateNukeRisk(actions: NukeAction[], options?: Record<string, any>): Record<string, any>
export function shouldCorrelateIncident(incident: Record<string, any>, action: NukeAction, options?: Record<string, any>): boolean
export function sanitizeSecurityMetadata(metadata: unknown): Record<string, unknown>
export function buildContainmentPlan(input: Record<string, any>): { allowed: boolean; code: string; removableRoleIds: string[] }
export function createSecuritySnapshot(input: Record<string, any>): Record<string, any>
export function buildRestorePreview(snapshot: Record<string, any>, current: Record<string, any>): Record<string, any>
export function selectRetainedSnapshots(snapshots: Array<Record<string, any>>, options?: Record<string, any>): Array<Record<string, any>>
