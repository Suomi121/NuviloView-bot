import "server-only";

import { getMultiDbSyncConfig } from "@/lib/sync/multi-config.mjs";
import { createProviderRegistry } from "@/lib/sync/providers/registry.mjs";
import { isEnabledFlag } from "@/lib/sync/providers/contract.mjs";
import { createWebReadRouter } from "@/lib/web-read-router.mjs";

export async function withWebReadRouter<T>(
  callback: (router: ReturnType<typeof createWebReadRouter>) => Promise<T>,
) {
  const config = getMultiDbSyncConfig(process.env);
  if (!config.webReadEnabled || !config.snapshotEnabled) {
    const error = new Error("Projection reads are not enabled.");
    Object.assign(error, { code: "WEB_PROJECTION_READ_DISABLED" });
    throw error;
  }
  const registry = await createProviderRegistry({ config });
  try {
    const router = createWebReadRouter({
      registry,
      intervalMs: config.analyticsCompaction.intervalMs,
      neonCompatibilityEnabled:
        config.providers.neon.enabled
        && isEnabledFlag(process.env.MULTI_DB_WEB_READ_NEON_COMPAT_ENABLED),
    });
    return await callback(router);
  } finally {
    await registry.close();
  }
}
