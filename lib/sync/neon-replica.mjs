import {
  assertReplicaDomain,
  calculateEnvelopeChecksum,
} from "./conflict-policy.mjs";
import {
  createMessageNeonReplicaAdapter,
  isMessageReplicaEvent,
} from "./message-neon-replica.mjs";

const batchReplicaSql = `
WITH incoming AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS item(
    event_id text,
    domain text,
    event_type text,
    aggregate_id text,
    payload jsonb,
    schema_version integer,
    checksum text,
    source_created_at bigint
  )
), inserted AS (
  INSERT INTO bot_event_replica (
    event_id, domain, event_type, aggregate_id, payload,
    schema_version, checksum, source_created_at
  )
  SELECT event_id, domain, event_type, aggregate_id, payload,
         schema_version, checksum, source_created_at
  FROM incoming
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id
)
SELECT incoming.event_id, replica.checksum
FROM incoming
JOIN bot_event_replica AS replica ON replica.event_id = incoming.event_id
`;

function resultRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

export class ReplicaConflictError extends Error {
  constructor(eventId) {
    super(`Replica checksum conflict for event ${eventId}.`);
    this.name = "ReplicaConflictError";
    this.code = "SYNC_CHECKSUM_MISMATCH";
    this.eventId = eventId;
  }
}

export function createNeonReplicaAdapter({ execute, close = async () => {} }) {
  if (typeof execute !== "function") {
    throw new TypeError("Neon replica execute function is required.");
  }

  const messageReplica = createMessageNeonReplicaAdapter({ execute });

  async function writeGenericBatch(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { succeededEventIds: [], failed: [] };
    }
    const records = items.map((item) => {
      const domain = assertReplicaDomain(item.domain);
      const expectedChecksum = calculateEnvelopeChecksum(item);
      if (item.checksum !== expectedChecksum) {
        throw new ReplicaConflictError(item.eventId);
      }
      return {
        event_id: item.eventId,
        domain,
        event_type: item.eventType,
        aggregate_id: item.aggregateId,
        payload: item.payload,
        schema_version: item.schemaVersion,
        checksum: item.checksum,
        source_created_at: item.createdAt,
      };
    });

    const result = await execute(batchReplicaSql, [JSON.stringify(records)]);
    const rows = resultRows(result);
    const checksums = new Map(
      rows.map((row) => [String(row.event_id), String(row.checksum)]),
    );
    for (const item of items) {
      if (checksums.get(item.eventId) !== item.checksum) {
        throw new ReplicaConflictError(item.eventId);
      }
    }
    return {
      succeededEventIds: items.map((item) => item.eventId),
      failed: [],
    };
  }

  async function writeBatch(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { succeededEventIds: [], failed: [] };
    }
    const messageItems = items.filter(isMessageReplicaEvent);
    const genericItems = items.filter((item) => !isMessageReplicaEvent(item));
    const [messageResult, genericResult] = await Promise.all([
      messageReplica.writeBatch(messageItems),
      writeGenericBatch(genericItems),
    ]);
    return {
      succeededEventIds: [
        ...messageResult.succeededEventIds,
        ...genericResult.succeededEventIds,
      ],
      failed: [...messageResult.failed, ...genericResult.failed],
    };
  }

  return Object.freeze({ writeBatch, close });
}

export { batchReplicaSql };
