import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { createProviderRegistry } from "../lib/sync/providers/registry.mjs";
import { createWebReadRouter } from "../lib/web-read-router.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function checksumMap(bundle) {
  return new Map(bundle.snapshots.map((snapshot) => [snapshot.aggregateId, snapshot.checksum]));
}

const guildId = argument("guild")
  ?? String(process.env.ANALYTICS_COMPACTION_GUILD_IDS ?? "").split(",")[0]?.trim();
if (!/^\d{16,22}$/.test(guildId ?? "")) {
  throw new TypeError("Pass a valid --guild Discord ID. No query was performed.");
}

const endDate = new Date().toISOString().slice(0, 10);
const startDate = addDays(endDate, -29);
const config = getMultiDbSyncConfig(process.env);
const registry = await createProviderRegistry({ config });

try {
  const results = [];
  for (const providerId of ["supabase", "turso"]) {
    if (!registry.get(providerId)?.isEnabled?.()) {
      results.push({ providerId, enabled: false });
      continue;
    }
    const router = createWebReadRouter({
      registry,
      priority: [providerId],
      intervalMs: config.analyticsCompaction.intervalMs,
    });
    const startedAt = performance.now();
    const bundle = await router.readAnalyticsBundle({ guildId, dateFrom: startDate, dateTo: endDate });
    results.push({
      providerId,
      enabled: true,
      available: bundle.available,
      freshness: bundle.metadata.freshness,
      lastUpdatedAt: bundle.metadata.lastUpdatedAt,
      observedAt: bundle.metadata.observedAt,
      observationSource: bundle.metadata.observationSource,
      snapshotVersion: bundle.metadata.snapshotVersion,
      currentChecksum: bundle.current?.checksum ?? null,
      projectionVersion:
        Number(bundle.current?.payload?.projectionVersion ?? 1),
      projectionSchemaVersion:
        Number(bundle.current?.payload?.schemaVersion ?? 0),
      projectionRows: bundle.snapshots.length,
      providerCalls: bundle.current
        ? (bundle.metadata.observationSource ? 3 : 2)
        : 1,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      rawAnalyticsQueries: router.getMetrics().rawAnalyticsQueries,
      checksums: checksumMap(bundle),
    });
  }
  const supabase = results.find((result) => result.providerId === "supabase");
  const turso = results.find((result) => result.providerId === "turso");
  const supabaseChecksums = supabase?.checksums ?? new Map();
  const tursoChecksums = turso?.checksums ?? new Map();
  const allKeys = new Set([...supabaseChecksums.keys(), ...tursoChecksums.keys()]);
  const mismatched = [...allKeys].filter(
    (key) => supabaseChecksums.get(key) !== tursoChecksums.get(key),
  );
  console.log(JSON.stringify({
    guildId,
    range: { startDate, endDate },
    providers: results.map(({ checksums: _checksums, ...result }) => result),
    reconciliation: {
      compared: allKeys.size,
      mismatched: mismatched.length,
      currentChecksumMatches: Boolean(
        supabase?.currentChecksum
        && supabase.currentChecksum === turso?.currentChecksum,
      ),
    },
  }, null, 2));
} finally {
  await registry.close();
}
