import "server-only";

import { getMultiDbSyncConfig } from "@/lib/sync/multi-config.mjs";
import { createProviderRegistry } from "@/lib/sync/providers/registry.mjs";
import { isEnabledFlag } from "@/lib/sync/providers/contract.mjs";
import { createWebReadRouter } from "@/lib/web-read-router.mjs";
import { getSecurityCoordinator } from '@/lib/multi-db/web-runtime';
import { createApplicationStore } from '@/lib/multi-db/application-store.mjs';
import { createApplicationProjectionRouter } from '@/lib/multi-db/application-projection.mjs';

export async function withWebReadRouter<T>(
  callback: (router: ReturnType<typeof createWebReadRouter>) => Promise<T>,
) {
  if (process.env.APPLICATION_DATA_MODE === 'quorum') {
    const runtime = await getSecurityCoordinator();
    if (!runtime) throw Object.assign(new Error('Quorum unavailable'), { code: 'APP_CONFIGURATION' });
    // This internal read adapter is reached only AFTER each route's Guild gate.
    // It grants no mutation or public unfiltered endpoint.
    const store = createApplicationStore({ ...runtime, authorize: async ({ operation }: { operation: string }) => operation === 'read' });
    const router = createApplicationProjectionRouter({ store, actorId: 'web-projection-reader', controlId: process.env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID });
    return callback(router as unknown as ReturnType<typeof createWebReadRouter>);
  }
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
      logger: console,
    });
    return await callback(router);
  } finally {
    await registry.close();
  }
}
