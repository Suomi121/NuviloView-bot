import { pathToFileURL } from "node:url";
import { createLocalStorage, getLocalStorageConfig } from "../lib/storage/index.mjs";
import {
  assertProviderId,
  getProviderPolicy,
} from "../lib/sync/providers/contract.mjs";
import { sanitizeSyncError } from "../lib/sync/retry.mjs";

function parseArguments(argv) {
  const providerValue = argv.find((value) => value.startsWith("--provider="));
  const limitValue = argv.find((value) => value.startsWith("--limit="));
  const confirmValue = argv.find((value) => value.startsWith("--confirm="));
  const providerId = assertProviderId(providerValue?.slice("--provider=".length));
  const limit = limitValue ? Number(limitValue.slice("--limit=".length)) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError("--limit must be between 1 and 10000.");
  }
  return {
    providerId,
    limit,
    execute: argv.includes("--execute"),
    confirmed: confirmValue?.slice("--confirm=".length) === providerId,
  };
}

export function backfillProvider({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const options = parseArguments(argv);
  const storageConfig = getLocalStorageConfig(env, { cwd });
  const storage = createLocalStorage({
    databasePath: storageConfig.databasePath,
    writeEnabled: options.execute,
    readOnly: !options.execute,
  });
  try {
    const plan = storage.providerDeliveries.planBackfill(options.providerId);
    if (!options.execute) {
      return { mode: "dry_run", ...plan, requestedLimit: options.limit };
    }
    if (!options.confirmed) {
      throw new Error(
        `Execution requires --confirm=${options.providerId}. No queue state was changed.`,
      );
    }
    const policy = getProviderPolicy(options.providerId);
    return {
      mode: "execute",
      plan,
      ...storage.providerDeliveries.executeBackfill(options.providerId, {
        required: policy.required,
        limit: options.limit,
      }),
    };
  } finally {
    storage.close();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(backfillProvider(), null, 2));
  } catch (error) {
    console.error(`[backfill-provider] ${sanitizeSyncError(error)}`);
    process.exitCode = 1;
  }
}
