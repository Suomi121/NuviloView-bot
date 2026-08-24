import { createHash } from "node:crypto";
import {
  createStableEventId,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../storage/contracts.mjs";

export const replicaDomains = Object.freeze([
  "bot_event",
  "analytics",
  "security",
  "moderation",
  "inventory",
  "history",
  "health",
]);

export const cloudPrimaryDomains = Object.freeze([
  "oauth",
  "web_session",
  "user_settings",
  "developer_operation",
  "support",
]);

const replicaDomainSet = new Set(replicaDomains);
const cloudPrimaryDomainSet = new Set(cloudPrimaryDomains);

export class UnsupportedSyncDomainError extends Error {
  constructor(domain) {
    const suffix = cloudPrimaryDomainSet.has(domain)
      ? " This is a cloud-primary domain."
      : "";
    super(`Unsupported local replica domain: ${domain}.${suffix}`);
    this.name = "UnsupportedSyncDomainError";
    this.code = "UNSUPPORTED_SYNC_DOMAIN";
    this.domain = domain;
  }
}

export function assertReplicaDomain(value) {
  const domain = requireString(value, "domain").toLowerCase();
  if (!replicaDomainSet.has(domain)) {
    throw new UnsupportedSyncDomainError(domain);
  }
  return domain;
}

export function calculateEnvelopeChecksum(envelope) {
  const canonical = serializeJson({
    eventId: envelope.eventId,
    domain: envelope.domain,
    eventType: envelope.eventType,
    aggregateId: envelope.aggregateId,
    payload: envelope.payload,
    schemaVersion: envelope.schemaVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeSyncEnvelope(input, { now = () => Date.now() } = {}) {
  const eventId = requireString(input?.eventId, "eventId");
  const domain = assertReplicaDomain(input?.domain);
  const eventType = requireString(input?.eventType, "eventType");
  const aggregateId = requireString(input?.aggregateId, "aggregateId");
  const schemaVersion = Number(input?.schemaVersion ?? 1);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError("schemaVersion must be a positive safe integer.");
  }
  const priority = Number(input?.priority ?? 0);
  if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
    throw new TypeError("priority must be a safe integer between -100 and 100.");
  }
  const createdAt = toEpochMilliseconds(input?.createdAt ?? now(), "createdAt");
  const availableAt = toEpochMilliseconds(
    input?.availableAt ?? createdAt,
    "availableAt",
  );
  const payload = input?.payload ?? {};
  const envelope = {
    id: input?.id
      ? requireString(input.id, "id")
      : createStableEventId("outbox", [eventId]),
    eventId,
    domain,
    eventType,
    aggregateId,
    payload,
    schemaVersion,
    priority,
    createdAt,
    availableAt,
  };
  const checksum = calculateEnvelopeChecksum(envelope);
  if (input?.checksum && String(input.checksum) !== checksum) {
    const error = new Error(`Checksum mismatch for event ${eventId}.`);
    error.code = "SYNC_CHECKSUM_MISMATCH";
    throw error;
  }
  return Object.freeze({ ...envelope, checksum });
}
