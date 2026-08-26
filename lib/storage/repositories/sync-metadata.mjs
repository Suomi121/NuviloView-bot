import {
  optionalString,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

function mapMetadata(row) {
  if (!row) return null;
  return {
    streamName: row.stream_name,
    cursor: row.cursor_value,
    state: row.state,
    lastAttemptAt:
      row.last_attempt_at === null ? null : Number(row.last_attempt_at),
    lastSuccessAt:
      row.last_success_at === null ? null : Number(row.last_success_at),
    metadata: parseJson(row.metadata_json),
    updatedAt: Number(row.updated_at),
  };
}

export function createSyncMetadataRepository(store, { now = () => Date.now() } = {}) {
  function get(streamName) {
    return mapMetadata(
      store.get(
        `SELECT stream_name, cursor_value, state, last_attempt_at,
                last_success_at, metadata_json, updated_at
         FROM sync_metadata WHERE stream_name = ?`,
        requireString(streamName, "streamName"),
      ),
    );
  }

  function set(input) {
    const streamName = requireString(input?.streamName, "streamName");
    const recordedAt = now();
    const lastAttemptAt =
      input?.lastAttemptAt === null || input?.lastAttemptAt === undefined
        ? null
        : toEpochMilliseconds(input.lastAttemptAt, "lastAttemptAt");
    const lastSuccessAt =
      input?.lastSuccessAt === null || input?.lastSuccessAt === undefined
        ? null
        : toEpochMilliseconds(input.lastSuccessAt, "lastSuccessAt");
    store.run(
      `INSERT INTO sync_metadata (
         stream_name, cursor_value, state, last_attempt_at, last_success_at,
         metadata_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (stream_name) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         state = excluded.state,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      streamName,
      optionalString(input?.cursor),
      requireString(input?.state ?? "idle", "state"),
      lastAttemptAt,
      lastSuccessAt,
      serializeJson(input?.metadata),
      recordedAt,
    );
    return get(streamName);
  }

  return Object.freeze({ get, set });
}
