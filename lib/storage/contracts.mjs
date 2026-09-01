import { createHash } from "node:crypto";

export class StorageDisabledError extends Error {
  constructor(message = "Local storage is disabled.") {
    super(message);
    this.name = "StorageDisabledError";
    this.code = "LOCAL_STORAGE_DISABLED";
  }
}

export class StorageReadOnlyError extends Error {
  constructor(message = "Local storage writes are disabled.") {
    super(message);
    this.name = "StorageReadOnlyError";
    this.code = "LOCAL_STORAGE_WRITE_DISABLED";
  }
}

export class StorageClosedError extends Error {
  constructor(message = "Local storage is closed.") {
    super(message);
    this.name = "StorageClosedError";
    this.code = "LOCAL_STORAGE_CLOSED";
  }
}

export function requireString(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${fieldName} is required.`);
  return normalized;
}

export function optionalString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function toEpochMilliseconds(value, fieldName = "occurredAt") {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (Number.isFinite(milliseconds)) return milliseconds;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return milliseconds;
  }
  throw new TypeError(`${fieldName} must be a valid Date, timestamp, or date string.`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function serializeJson(value) {
  return JSON.stringify(canonicalize(value ?? {}));
}

export function parseJson(value, fallback = {}) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createStableEventId(namespace, parts) {
  const normalizedNamespace = requireString(namespace, "namespace")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("parts must contain at least one stable value.");
  }
  const normalizedParts = parts.map((part, index) =>
    requireString(part, `parts[${index}]`),
  );
  const readable = `${normalizedNamespace}:${normalizedParts.map(encodeURIComponent).join(":")}`;
  if (readable.length <= 240) return readable;
  const digest = createHash("sha256")
    .update(serializeJson(normalizedParts))
    .digest("hex");
  return `${normalizedNamespace}:sha256:${digest}`;
}

export function assertStorageContract(storage) {
  const methods = [
    ["messages", "upsert"],
    ["messages", "markDeleted"],
    ["messageDomain", "recordEvent"],
    ["messageDomain", "getMetrics"],
    ["historyImport", "saveBatch"],
    ["historyImport", "deleteImportedHistory"],
    ["analytics", "recordMessageEvent"],
    ["analytics", "recordReactionEvent"],
    ["analytics", "recordReactionTransition"],
    ["analytics", "recordVoiceEvent"],
    ["analytics", "recordVoiceTransition"],
    ["analytics", "recordMemberEvent"],
    ["analytics", "recordMemberTransition"],
    ["analyticsProjections", "markMessageEvent"],
    ["analyticsProjections", "markReactionEvent"],
    ["analyticsProjections", "markVoiceEvent"],
    ["analyticsProjections", "markMemberEvent"],
    ["analyticsProjections", "listDue"],
    ["analyticsProjections", "getMetrics"],
    ["security", "appendAudit"],
    ["config", "getLastKnownGuildPolicy"],
    ["health", "getStatus"],
    ["health", "checkIntegrity"],
    ["health", "checkpoint"],
    ["outbox", "enqueue"],
    ["outbox", "claimBatch"],
    ["outbox", "markSynced"],
    ["outbox", "moveToDeadLetter"],
    ["providerDeliveries", "getProviderStatus"],
    ["providerDeliveries", "isCloudComplete"],
    ["snapshots", "upsert"],
    ["snapshots", "get"],
    ["snapshots", "listForReconciliation"],
    ["retentionFoundation", "planProjection"],
    ["retentionFoundation", "compareShadow"],
  ];
  for (const [namespace, method] of methods) {
    if (typeof storage?.[namespace]?.[method] !== "function") {
      throw new TypeError(`Storage contract is missing ${namespace}.${method}().`);
    }
  }
  if (typeof storage?.close !== "function") {
    throw new TypeError("Storage contract is missing close().");
  }
  return storage;
}
