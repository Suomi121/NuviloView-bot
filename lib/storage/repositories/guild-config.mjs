import {
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

function mapConfig(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    version: Number(row.version),
    policy: parseJson(row.policy_json),
    sourceUpdatedAt:
      row.source_updated_at === null ? null : Number(row.source_updated_at),
    cachedAt: Number(row.cached_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createGuildConfigRepository(store, { now = () => Date.now() } = {}) {
  function getLastKnownGuildPolicy(guildId) {
    return mapConfig(
      store.get(
        `SELECT guild_id, version, policy_json, source_updated_at, cached_at, updated_at
         FROM local_guild_config WHERE guild_id = ?`,
        requireString(guildId, "guildId"),
      ),
    );
  }

  function setLastKnownGuildPolicy(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const version = Number(input?.version ?? 0);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("version must be a non-negative safe integer.");
    }
    const recordedAt = now();
    const sourceUpdatedAt =
      input?.sourceUpdatedAt === null || input?.sourceUpdatedAt === undefined
        ? null
        : toEpochMilliseconds(input.sourceUpdatedAt, "sourceUpdatedAt");
    store.run(
      `INSERT INTO local_guild_config (
         guild_id, version, policy_json, source_updated_at, cached_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         version = excluded.version,
         policy_json = excluded.policy_json,
         source_updated_at = excluded.source_updated_at,
         cached_at = excluded.cached_at,
         updated_at = excluded.updated_at
       WHERE excluded.version >= local_guild_config.version`,
      guildId,
      version,
      serializeJson(input?.policy),
      sourceUpdatedAt,
      recordedAt,
      recordedAt,
    );
    return getLastKnownGuildPolicy(guildId);
  }

  return Object.freeze({
    getLastKnownGuildPolicy,
    setLastKnownGuildPolicy,
  });
}
