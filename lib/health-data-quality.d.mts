export type HealthQualityState = "Available" | "LowConfidence" | "Immature" | "Unavailable";
export type HealthQualityCategory = {
  score: number | null;
  confidence: "high" | "medium" | "low" | "none";
  observationDays: number;
  qualityState: HealthQualityState;
  reason: string;
  usable: boolean;
};
export type HealthDataQualityGate = {
  schemaVersion: number;
  passes: boolean;
  blockingReasons: string[];
  sanitization: { retentionUsable: boolean; voiceUsable: boolean; reactionUsable: boolean };
  categories: Record<string, HealthQualityCategory>;
  components: { reaction: HealthQualityCategory };
  evidence: Record<string, unknown>;
};
export function createHealthDataQualityGate(input: any): HealthDataQualityGate;
export function attachHealthScoresToQualityGate(gate: HealthDataQualityGate, health: any): HealthDataQualityGate;
