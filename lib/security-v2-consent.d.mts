type Query = (text: string, values: unknown[]) => Promise<unknown>;
export type SecurityV2State = { migrationState: string; autoTimeout: boolean; emergencyStop: boolean; effective: boolean; revision: string };
export function readSecurityV2(query: Query, guildId: string): Promise<SecurityV2State>;
export function enrollSecurityV2(query: Query, guildId: string): Promise<void>;
export function setSecurityV2Auto(query: Query, guildId: string, actorId: string, operation: string): Promise<{ autoTimeout: boolean; revision: string }>;
export function mayAutomaticallyTimeout(query: Query, guildId: string, options?: { emergencyStop?: boolean }): Promise<boolean>;
export declare const SECURITY_V2_TIMEOUT_MS: number;
