const transientNetworkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const transientDatabaseCodes = new Set(["40001", "40P01", "53300", "57P03"]);
const unavailableSchemaCodes = new Set([
  "42P01", // PostgreSQL undefined_table
  "42703", // PostgreSQL undefined_column
  "42883", // PostgreSQL undefined_function
  "SQLITE_ERROR",
  "SYNC_PROVIDER_SCHEMA_UNAVAILABLE",
]);

export function sanitizeSyncError(error, maxLength = 2_000) {
  const source = String(error?.message ?? error ?? "Unknown synchronization error");
  return source
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, maxLength);
}

export function classifySyncError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  const message = sanitizeSyncError(error).toLowerCase();

  if (code === "SYNC_PROVIDER_CREDENTIALS_MISSING") {
    return { kind: "configuration", retryable: true, affectsCircuit: true };
  }
  if (
    unavailableSchemaCodes.has(code) ||
    /no such table|no such column|relation .* does not exist|undefined (?:table|column|function)/.test(
      message,
    )
  ) {
    return { kind: "schema_unavailable", retryable: true, affectsCircuit: true };
  }
  if (
    code === "UNSUPPORTED_SYNC_DOMAIN" ||
    code === "SYNC_CHECKSUM_MISMATCH" ||
    code === "SYNC_SCHEMA_MISMATCH" ||
    code === "SYNC_INVALID_PAYLOAD" ||
    (/^(22|23)/.test(code) && !transientDatabaseCodes.has(code)) ||
    /invalid payload|schema mismatch|constraint violation/.test(message)
  ) {
    return { kind: "permanent", retryable: false, affectsCircuit: false };
  }
  if (status === 429 || code === "429" || /rate.?limit|too many requests/.test(message)) {
    return { kind: "rate_limit", retryable: true, affectsCircuit: true };
  }
  if (status === 402 || /quota|usage limit|resource exhausted/.test(message)) {
    return { kind: "quota", retryable: true, affectsCircuit: true };
  }
  if (
    transientNetworkCodes.has(code) ||
    transientDatabaseCodes.has(code) ||
    status >= 500 ||
    /timeout|timed out|connection|network|temporar|unavailable/.test(message)
  ) {
    return { kind: "transient", retryable: true, affectsCircuit: true };
  }
  return { kind: "permanent", retryable: false, affectsCircuit: false };
}

export function calculateRetryDelay({
  attempt,
  baseMs = 1_000,
  maxMs = 300_000,
  jitterRatio = 0.2,
  random = Math.random,
}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("attempt must be a positive integer.");
  }
  if (!Number.isFinite(baseMs) || baseMs < 1 || !Number.isFinite(maxMs) || maxMs < baseMs) {
    throw new TypeError("Retry delay bounds are invalid.");
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError("jitterRatio must be between 0 and 1.");
  }
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
  const jitter = exponential * jitterRatio;
  const unit = Math.min(1, Math.max(0, Number(random())));
  return Math.max(1, Math.round(exponential - jitter + unit * jitter * 2));
}
