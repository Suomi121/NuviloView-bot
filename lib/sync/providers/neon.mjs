import { createNeonReplicaAdapter } from "../neon-replica.mjs";
import { createPostgresProviderAdapter } from "./postgres.mjs";
import { assertSyncProvider } from "./contract.mjs";

export function createNeonProviderAdapter({
  enabled = false,
  execute,
  close = async () => {},
} = {}) {
  const legacyEvents = createNeonReplicaAdapter({ execute, close });
  const snapshots = createPostgresProviderAdapter({
    id: "neon",
    required: false,
    enabled,
    execute,
    close,
  });
  return assertSyncProvider(
    Object.freeze({
      ...snapshots,
      pushEvents: (items) => legacyEvents.writeBatch(items),
      close,
    }),
  );
}
