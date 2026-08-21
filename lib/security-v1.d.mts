export declare const SECURITY_V1_INCIDENT_TYPES: Readonly<Record<string, string>>
export declare const DEFAULT_SECURITY_V1_THRESHOLDS: Readonly<Record<string, number>>
export declare const DEFAULT_SECURITY_V1_POLICY: Readonly<Record<string, unknown>>
export function normalizeSecurityV1Thresholds(input?: Record<string, unknown>): Record<string, number>
export function normalizeSecurityV1Policy(input?: Record<string, unknown>): Record<string, any>
export function getSecurityV1Detector(actionType: string, policyInput?: Record<string, unknown>): Record<string, any> | null
export function shouldMonitorSecurityV1Actor(input: Record<string, any>): boolean
export function hasEveryoneOrHereMention(message: Record<string, any>): boolean
export class SecurityV1WindowTracker {
  constructor(options?: Record<string, number>)
  record(event: Record<string, any>, policyInput?: Record<string, unknown>, now?: number): Record<string, any>
  prune(now?: number): void
  clearGuild(guildId: string): void
}
export function executeBestEffort(items: unknown[], worker: (item: any) => Promise<any>): Promise<Array<Record<string, any>>>
export function summarizeBestEffort(results: Array<Record<string, any>>): Record<string, any>
