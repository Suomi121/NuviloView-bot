import { pathToFileURL } from "node:url";
import { createLocalStorage, getLocalStorageConfig } from "../lib/storage/index.mjs";
import { sanitizeSyncError } from "../lib/sync/retry.mjs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CONFIRMATION = "PROJECTION_V2_BACKFILL";

function option(argv, name) {
  return argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function integerOption(argv, name, fallback, { min, max }) {
  const raw = option(argv, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

export function parseProjectionBackfillArguments(argv = process.argv.slice(2)) {
  const guildId = option(argv, "--guild")?.trim() ?? "";
  const from = option(argv, "--from")?.trim() ?? "";
  const to = option(argv, "--to")?.trim() ?? "";
  if (!/^\d{16,22}$/.test(guildId)) throw new TypeError("--guild must be a Discord Guild ID.");
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    throw new TypeError("--from and --to must be YYYY-MM-DD.");
  }
  const startAt = Date.parse(`${from}T00:00:00.000Z`);
  const endAt = Date.parse(`${to}T00:00:00.000Z`) + 86_400_000;
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    throw new TypeError("The requested date range is invalid.");
  }
  return Object.freeze({
    guildId,
    from,
    to,
    startAt,
    endAt,
    maxBuckets: integerOption(argv, "--max-buckets", 250, { min: 1, max: 10_000 }),
    batchSize: integerOption(argv, "--batch-size", 50, { min: 1, max: 250 }),
    rateMs: integerOption(argv, "--rate-ms", 250, { min: 0, max: 60_000 }),
    execute: argv.includes("--execute"),
    confirmed: option(argv, "--confirm") === CONFIRMATION,
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function backfillAnalyticsProjectionV2({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  sleep = wait,
} = {}) {
  const options = parseProjectionBackfillArguments(argv);
  if (options.execute && !options.confirmed) {
    throw new Error(`Execution requires --confirm=${CONFIRMATION}. No bucket was changed.`);
  }
  const storageConfig = getLocalStorageConfig(env, { cwd });
  const storage = createLocalStorage({
    databasePath: storageConfig.databasePath,
    writeEnabled: options.execute,
    readOnly: !options.execute,
  });
  try {
    const plan = storage.analyticsProjections.listBackfillCandidates(options);
    const summary = {
      mode: options.execute ? "execute" : "dry_run",
      guildId: options.guildId,
      from: options.from,
      to: options.to,
      candidateBuckets: plan.candidates.length,
      truncated: plan.truncated,
      maxBuckets: options.maxBuckets,
      projectionKinds: Object.fromEntries(
        [...new Set(plan.candidates.map((item) => item.projectionKind))]
          .sort()
          .map((kind) => [
            kind,
            plan.candidates.filter((item) => item.projectionKind === kind).length,
          ]),
      ),
    };
    if (!options.execute) return { ...summary, marked: 0 };
    let marked = 0;
    for (let offset = 0; offset < plan.candidates.length; offset += options.batchSize) {
      const batch = plan.candidates.slice(offset, offset + options.batchSize);
      marked += storage.analyticsProjections.markBackfillCandidates(batch).marked;
      if (offset + options.batchSize < plan.candidates.length && options.rateMs > 0) {
        await sleep(options.rateMs);
      }
    }
    return { ...summary, marked };
  } finally {
    storage.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(await backfillAnalyticsProjectionV2(), null, 2));
  } catch (error) {
    console.error(`[projection-v2-backfill] ${sanitizeSyncError(error)}`);
    process.exitCode = 1;
  }
}
