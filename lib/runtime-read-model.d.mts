import type { WebSnapshotReadResult } from "./web-read-router.mjs";

export type RuntimeProviderReadModel = {
  providerId: string;
  required: boolean;
  enabled: boolean;
  status: string;
  circuit: string;
  pending: number;
  retry: number;
  deadLetter: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  queryCount: number;
};

export function buildRuntimeReadModel(input: {
  runtimeRead: WebSnapshotReadResult;
  syncRead: WebSnapshotReadResult;
  at?: number;
}): {
  overallStatus: string;
  botStatus: string;
  workerStatus: string;
  sqliteStatus: string;
  lastSuccessfulSync: number | null;
  pendingCount: number;
  retryCount: number;
  deadLetterCount: number;
  providers: readonly RuntimeProviderReadModel[];
  readMeta: {
    runtime: WebSnapshotReadResult["metadata"] | null;
    sync: WebSnapshotReadResult["metadata"] | null;
    generatedAt: number;
    degraded: boolean;
  };
};
