import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { RuntimeCoordinator, createRuntimeLeaseRepository } from "../lib/runtime-singleton.mjs";

if (!process.argv.includes("--execute-test-service")) {
  console.error("Refusing to change lease rows without --execute-test-service.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const runId = randomUUID();
const serviceKey = `nuviloview.discord-bot.failover-test.${runId}`;
if (!serviceKey.startsWith("nuviloview.discord-bot.failover-test.")) {
  throw new Error("Failover rehearsal must never use the production service key.");
}
const config = {
  enabled: true,
  serviceKey,
  ttlSeconds: 15,
  renewSeconds: 5,
  heartbeatSeconds: 5,
  proofSafetySeconds: 2,
  heartbeatRetentionDays: 1,
};
const identity = (hostId, instanceId) => ({
  hostId,
  instanceId,
  hostname: hostId,
  platform: "FailoverRehearsal",
  pid: process.pid,
  startedAt: new Date(),
  appVersion: process.env.npm_package_version || "0.1.0",
  runtimeVersion: process.version,
  commitSha: process.env.NUVILOVIEW_COMMIT_SHA || null,
});
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});
const repository = createRuntimeLeaseRepository((text, parameters) => pool.query(text, parameters));
const report = {
  schemaVersion: 1,
  runId,
  serviceKey,
  startedAt: new Date().toISOString(),
  productionServiceTouched: false,
  checks: [],
  result: "failed",
};

function check(name, passed, details = {}) {
  report.checks.push({ name, passed, ...details });
  if (!passed) throw new Error(`Failover rehearsal failed: ${name}`);
}

let hostALost = false;
const hostA = new RuntimeCoordinator({
  repository,
  config,
  identity: identity("rehearsal-host-a", `a-${runId}`),
  logger,
  onLeaseLost: async () => { hostALost = true; },
});
const hostBContender = new RuntimeCoordinator({
  repository,
  config,
  identity: identity("rehearsal-host-b", `b-contended-${runId}`),
  logger,
});
let hostB = null;

try {
  const acquiredA = await hostA.acquire();
  check("host_a_acquires", acquiredA.acquired === true, { fencingToken: acquiredA.lease?.fencingToken || null });
  await hostA.recordNow();

  const contendedB = await hostBContender.acquire();
  check("host_b_contended_while_a_valid", contendedB.acquired === false);

  await new Promise((resolve) => setTimeout(resolve, (config.ttlSeconds + 1) * 1_000));
  hostB = new RuntimeCoordinator({
    repository,
    config,
    identity: identity("rehearsal-host-b", `b-owner-${runId}`),
    logger,
  });
  const acquiredB = await hostB.acquire();
  check("host_b_takes_over_after_ttl", acquiredB.acquired === true, { fencingToken: acquiredB.lease?.fencingToken || null });
  check(
    "fencing_token_increments",
    Number(acquiredB.lease?.fencingToken) === Number(acquiredA.lease?.fencingToken) + 1,
  );
  await hostB.recordNow();

  const staleRenew = await hostA.renewOnce();
  check("stale_owner_renew_rejected", staleRenew === false);
  check("stale_owner_loss_callback", hostALost === true);

  const currentRenew = await hostB.renewOnce();
  check("new_owner_renews", currentRenew === true);
  const staleRelease = await repository.release({
    serviceKey,
    instanceId: hostA.identity.instanceId,
    fencingToken: hostA.fencingToken,
  });
  check("stale_owner_release_rejected", staleRelease === false);
  await hostB.stop();
  report.result = "passed";
} finally {
  report.finishedAt = new Date().toISOString();
  await pool.query('DELETE FROM "service_heartbeat" WHERE "serviceKey" = $1', [serviceKey]).catch(() => {});
  await pool.query('DELETE FROM "service_lease" WHERE "serviceKey" = $1', [serviceKey]).catch(() => {});
  await pool.end();
  const outputDirectory = path.resolve("output/release-readiness/runtime-failover");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `runtime-failover-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, checks: report.checks.length, outputPath }));
}
