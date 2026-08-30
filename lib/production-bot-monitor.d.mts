export interface ProjectionReadResult {
  available?: boolean;
  snapshot?: {
    generatedAt?: number | null;
    payload?: Record<string, unknown> | null;
  } | null;
  metadata?: {
    provider?: string | null;
    degraded?: boolean;
    lastKnownGood?: boolean;
  } | null;
  attempts?: readonly string[];
}

export interface ProjectionBotHealthResult {
  available: boolean;
  state: "Healthy" | "Warning" | "Down";
  reason: string;
  model: unknown;
}

export function evaluateProjectionBotHealth(input?: {
  runtimeRead?: ProjectionReadResult | null;
  syncRead?: ProjectionReadResult | null;
  at?: number;
  maxAgeMs?: number;
}): ProjectionBotHealthResult;
