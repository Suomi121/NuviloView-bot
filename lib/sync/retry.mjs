const transientNetworkCodes = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
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

function getErrorChain(error) {
  const queue = [error];
  const seen = new Set();
  const chain = [];
  while (queue.length > 0 && chain.length < 12) {
    const current = queue.shift();
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    chain.push(current);
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return chain;
}

function normalizedCode(error) {
  return String(error?.code ?? "").toUpperCase();
}

function normalizedStatus(error) {
  return Number(error?.status ?? error?.statusCode ?? 0);
}

function isLibsqlFetchFailure(chain) {
  const libsqlExecuteError = chain.some(
    (item) => item?.name === "LibsqlError" && normalizedCode(item) === "EXECUTE_ERROR",
  );
  return (
    libsqlExecuteError &&
    chain.some((item) => /^fetch failed$/i.test(String(item?.message ?? "").trim()))
  );
}

export function classifySyncError(error) {
  const chain = getErrorChain(error);
  if (chain.length === 0) chain.push(error);
  const codes = new Set(chain.map(normalizedCode).filter(Boolean));
  const statuses = chain.map(normalizedStatus).filter((status) => status > 0);
  const message = chain.map((item) => sanitizeSyncError(item)).join(" ").toLowerCase();

  if (codes.has("SYNC_PROVIDER_CREDENTIALS_MISSING")) {
    return { kind: "configuration", retryable: true, affectsCircuit: true };
  }
  if (
    [...codes].some((code) => unavailableSchemaCodes.has(code)) ||
    /no such table|no such column|relation .* does not exist|undefined (?:table|column|function)/.test(
      message,
    )
  ) {
    return { kind: "schema_unavailable", retryable: true, affectsCircuit: true };
  }
  if (
    codes.has("UNSUPPORTED_SYNC_DOMAIN") ||
    codes.has("SYNC_CHECKSUM_MISMATCH") ||
    codes.has("SYNC_SCHEMA_MISMATCH") ||
    codes.has("SYNC_INVALID_PAYLOAD") ||
    [...codes].some(
      (code) => /^(22|23)/.test(code) && !transientDatabaseCodes.has(code),
    ) ||
    /invalid payload|schema mismatch|constraint violation/.test(message)
  ) {
    return { kind: "permanent", retryable: false, affectsCircuit: false };
  }
  if (
    statuses.some((status) => status === 401 || status === 403) ||
    codes.has("401") ||
    codes.has("403") ||
    /unauthori[sz]ed|forbidden|authentication failed|invalid (?:token|credential)/.test(
      message,
    )
  ) {
    return { kind: "permanent", retryable: false, affectsCircuit: false };
  }
  if (
    statuses.includes(429) ||
    codes.has("429") ||
    /rate.?limit|too many requests/.test(message)
  ) {
    return { kind: "rate_limit", retryable: true, affectsCircuit: true };
  }
  if (statuses.includes(402) || /quota|usage limit|resource exhausted/.test(message)) {
    return { kind: "quota", retryable: true, affectsCircuit: true };
  }
  if (
    [...codes].some(
      (code) => transientNetworkCodes.has(code) || transientDatabaseCodes.has(code),
    ) ||
    statuses.some((status) => status >= 500) ||
    /timeout|timed out|connection|network|temporar|unavailable/.test(message) ||
    isLibsqlFetchFailure(chain)
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
