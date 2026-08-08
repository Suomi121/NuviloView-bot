const HEALTH_V2_RELEASE_STAGES = new Set(["off", "preview", "stable"]);

export function resolveHealthV2ReleaseConfig(environment = process.env) {
  const requestedStage = String(environment.HEALTH_V2_RELEASE_STAGE ?? "preview").trim().toLowerCase();
  const stage = HEALTH_V2_RELEASE_STAGES.has(requestedStage) ? requestedStage : "preview";
  const official = stage === "stable";
  const visible = stage !== "off";
  const shadowWriteEnabled = stage === "preview" && String(environment.HEALTH_V2_SHADOW_WRITE_ENABLED ?? "true").toLowerCase() !== "false";

  return Object.freeze({
    schemaVersion: 2,
    stage,
    mode: official ? "official" : stage === "preview" ? "shadow" : "disabled",
    official,
    visible,
    shadowWriteEnabled,
  });
}

export function healthV2SnapshotScore(health, release) {
  return release.official ? health.score : null;
}

export function healthV2HistoryEntry(row, release) {
  const metadata = row?.categories?._healthV2;
  const isShadow = metadata?.mode === "shadow" || metadata?.releaseStage === "preview";
  const score = release.official
    ? row?.score ?? null
    : isShadow
      ? metadata?.shadowScore ?? metadata?.formalCandidateScore ?? metadata?.provisionalScore ?? null
      : null;

  return {
    date: row?.date ?? null,
    score,
    confidence: row?.confidence ?? null,
    categories: row?.categories ?? {},
    isShadow,
    releaseStage: metadata?.releaseStage ?? null,
  };
}
