export type HealthV2ReleaseStage = "off" | "preview" | "stable";
export type HealthV2ReleaseConfig = {
  schemaVersion: 2;
  stage: HealthV2ReleaseStage;
  mode: "disabled" | "shadow" | "official";
  official: boolean;
  visible: boolean;
  shadowWriteEnabled: boolean;
};

export function resolveHealthV2ReleaseConfig(environment?: Record<string, string | undefined>): HealthV2ReleaseConfig;
export function healthV2SnapshotScore(health: { score: number | null }, release: HealthV2ReleaseConfig): number | null;
export function healthV2HistoryEntry(row: Record<string, any>, release: HealthV2ReleaseConfig): {
  date: string | null;
  score: number | null;
  confidence: string | null;
  categories: Record<string, any>;
  isShadow: boolean;
  releaseStage: string | null;
};
