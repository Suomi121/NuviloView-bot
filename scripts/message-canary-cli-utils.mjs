import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { sanitizeSyncError } from "../lib/sync/retry.mjs";

const { Client } = pg;

export function loadWorkerSnapshot(env = process.env, { cwd = process.cwd() } = {}) {
  const path = resolve(
    cwd,
    env.SYNC_METRICS_PATH?.trim() || "data/runtime/sync-worker-health.json",
  );
  if (!existsSync(path)) return { path, snapshot: null };
  const size = statSync(path).size;
  if (size > 1_048_576) throw new Error("Sync Worker health snapshot exceeds 1 MiB.");
  return { path, snapshot: JSON.parse(readFileSync(path, "utf8")) };
}

export async function withReadonlyMessageReplica(env, callback) {
  const connectionString = env.MESSAGE_CANARY_READONLY_DATABASE_URL?.trim();
  if (!connectionString) return { available: false, value: null };
  const client = new Client({
    connectionString,
    application_name: "nuviloview-message-canary-readonly",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const value = await callback((text, parameters) => client.query(text, parameters));
    await client.query("COMMIT");
    return { available: true, value };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const safe = new Error(sanitizeSyncError(error));
    safe.code = error?.code;
    throw safe;
  } finally {
    await client.end();
  }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
