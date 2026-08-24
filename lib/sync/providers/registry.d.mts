export type CloudSnapshot = {
  snapshotType: string;
  aggregateId: string;
  snapshotVersion: number;
  payload: Record<string, unknown>;
  checksum: string;
  generatedAt: number;
  syncedAt: number;
};

export type SyncProvider = {
  id: "supabase" | "turso" | "neon";
  required: boolean;
  isEnabled(): boolean;
  readSnapshot(input: {
    snapshotType: string;
    aggregateId: string;
  }): Promise<CloudSnapshot | null>;
  close(): Promise<void>;
};

export type ProviderRegistry = {
  get(providerId: string): SyncProvider | null;
  has(providerId: string): boolean;
  list(): SyncProvider[];
  enabledProviderIds(): string[];
  initializationErrors(): Record<string, string>;
  close(): Promise<void>;
};

export function createProviderRegistry(options: {
  config: unknown;
  clients?: Record<string, unknown>;
  poolFactory?: (...args: unknown[]) => unknown;
  tursoClientFactory?: ((options: unknown) => unknown) | null;
  logger?: Console;
}): Promise<ProviderRegistry>;
