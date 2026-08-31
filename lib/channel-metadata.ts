import "server-only";

export type ChannelMetadata = {
  name: string;
  deleted: boolean;
};

type CacheEntry = {
  expiresAt: number;
  value: Readonly<Record<string, ChannelMetadata>>;
};

const CACHE_TTL_MS = 5 * 60_000;
const globalCache = globalThis as typeof globalThis & {
  nuviloChannelMetadataCache?: Map<string, CacheEntry>;
  nuviloChannelMetadataLoads?: Map<string, Promise<Readonly<Record<string, ChannelMetadata>>>>;
};
const cache = globalCache.nuviloChannelMetadataCache ??= new Map();
const loads = globalCache.nuviloChannelMetadataLoads ??= new Map();

function validChannelName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^#+/, "");
  return name && name.length <= 100 ? name : null;
}

async function relationExists(name: string) {
  // Channel registries are part of the legacy Bot/Discord schema, not the
  // isolated Web Auth database. Keep this read-only lookup on that schema.
  const { pool } = await import("@/lib/db");
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass($1) AS relation",
    [`public.${name}`],
  );
  return Boolean(result.rows[0]?.relation);
}

async function loadChannelMetadata(guildId: string) {
  const { pool } = await import("@/lib/db");
  const result: Record<string, ChannelMetadata> = {};
  if (await relationExists("guild_channel_registry")) {
    const registry = await pool.query<{
      channelId: string;
      channelName: string;
      deletedAt: Date | null;
    }>(`
      SELECT "channelId", "channelName", "deletedAt"
      FROM "guild_channel_registry"
      WHERE "guildId" = $1
      ORDER BY "updatedAt" DESC
      LIMIT 1000
    `, [guildId]);
    for (const row of registry.rows) {
      const name = validChannelName(row.channelName);
      if (name && !result[row.channelId]) {
        result[row.channelId] = { name, deleted: row.deletedAt !== null };
      }
    }
  }
  if (await relationExists("bot_channel_access")) {
    const access = await pool.query<{
      channelId: string;
      channelName: string;
    }>(`
      SELECT "channelId", "channelName"
      FROM "bot_channel_access"
      WHERE "guildId" = $1
      ORDER BY "checkedAt" DESC
      LIMIT 1000
    `, [guildId]);
    for (const row of access.rows) {
      const name = validChannelName(row.channelName);
      if (name && !result[row.channelId]) {
        result[row.channelId] = { name, deleted: false };
      }
    }
  }
  return Object.freeze(result);
}

export async function getGuildChannelMetadata(guildId: string) {
  if (!/^\d{16,22}$/.test(guildId)) return Object.freeze({});
  const cached = cache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = loads.get(guildId);
  if (existing) return existing;
  const load = (async () => {
    try {
      const value = await loadChannelMetadata(guildId);
      cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "metadata_unavailable";
      console.warn("Channel metadata lookup unavailable:", code);
      const fallback = cached?.value ?? Object.freeze({});
      cache.set(guildId, { value: fallback, expiresAt: Date.now() + 60_000 });
      return fallback;
    }
  })();
  loads.set(guildId, load);
  try {
    return await load;
  } finally {
    if (loads.get(guildId) === load) loads.delete(guildId);
  }
}
