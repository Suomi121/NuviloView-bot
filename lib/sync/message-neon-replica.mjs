import {
  assertReplicaDomain,
  calculateEnvelopeChecksum,
} from "./conflict-policy.mjs";

export const messageReplicaEventTypes = Object.freeze(
  new Set([
    "message_create",
    "message_update",
    "message_delete",
    "message_active_member",
  ]),
);

export const messageBatchReplicaSql = `
SELECT event_id, checksum
FROM sync_message_event_batch($1::jsonb)
`;

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

export class MessageReplicaConflictError extends Error {
  constructor(eventId) {
    super(`Message replica checksum conflict for event ${eventId}.`);
    this.name = "MessageReplicaConflictError";
    this.code = "SYNC_CHECKSUM_MISMATCH";
    this.eventId = eventId;
  }
}

export function isMessageReplicaEvent(item) {
  return messageReplicaEventTypes.has(item?.eventType);
}

export function createMessageNeonReplicaAdapter({ execute }) {
  if (typeof execute !== "function") {
    throw new TypeError("Message Neon replica execute function is required.");
  }

  async function writeBatch(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { succeededEventIds: [], failed: [] };
    }
    const records = items.map((item) => {
      assertReplicaDomain(item.domain);
      if (!isMessageReplicaEvent(item)) {
        throw new TypeError(`Unsupported Message replica event: ${item.eventType}.`);
      }
      if (calculateEnvelopeChecksum(item) !== item.checksum) {
        throw new MessageReplicaConflictError(item.eventId);
      }
      return {
        event_id: item.eventId,
        event_type: item.eventType,
        aggregate_id: item.aggregateId,
        payload: item.payload,
        schema_version: item.schemaVersion,
        checksum: item.checksum,
        source_created_at: item.createdAt,
      };
    });
    const result = await execute(messageBatchReplicaSql, [JSON.stringify(records)]);
    const checksums = new Map(
      rows(result).map((row) => [String(row.event_id), String(row.checksum)]),
    );
    for (const item of items) {
      if (checksums.get(item.eventId) !== item.checksum) {
        throw new MessageReplicaConflictError(item.eventId);
      }
    }
    return {
      succeededEventIds: items.map((item) => item.eventId),
      failed: [],
    };
  }

  return Object.freeze({ writeBatch });
}

