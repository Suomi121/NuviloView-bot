const MODES = new Set(["off", "shadow"]);

function integer(value, fallback, { min, max }) {
  const normalized = value === undefined || value === "" ? fallback : Number(value);
  return Number.isSafeInteger(normalized) && normalized >= min && normalized <= max
    ? normalized
    : fallback;
}

export function getRetentionFoundationConfig(env = process.env) {
  const requestedMode = String(env.RETENTION_FOUNDATION_MODE ?? "off")
    .trim()
    .toLowerCase();
  const mode = MODES.has(requestedMode) ? requestedMode : "off";
  const errors = [];
  if (!MODES.has(requestedMode)) errors.push("retention_foundation_mode_invalid");
  return Object.freeze({
    mode,
    enabled: mode === "shadow",
    deleteEnabled: false,
    lateEventGraceDays: integer(env.RETENTION_LATE_EVENT_GRACE_DAYS, 30, {
      min: 1,
      max: 365,
    }),
    errors: Object.freeze(errors),
  });
}
