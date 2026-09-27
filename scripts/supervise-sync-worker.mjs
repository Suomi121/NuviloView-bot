import { resolve, join } from "node:path";
import fs from "node:fs";
import { createBoundedWorkerLog, heartbeatThreshold, inspectWorker, superviseWorker } from "../lib/sync/worker-supervisor.mjs";

const [mode, project, runtime, logs] = process.argv.slice(2);
const cwd = resolve(project), runtimeDir = resolve(runtime);
const metricsPath = resolve(cwd, process.env.SYNC_METRICS_PATH || "data/runtime/sync-worker-health.json");
const thresholdMs = heartbeatThreshold();
if (mode === "--status") {
  console.log(`Sync Worker: ${inspectWorker({ runtimeDir, metricsPath, thresholdMs }).state}`);
} else if (mode === "--run") {
  const configuredMax = Number(process.env.ANDROID_RUNNER_LOG_MAX_BYTES ?? 10485760);
  const maxBytes = Number.isSafeInteger(configuredMax) && configuredMax >= 1024 && configuredMax <= 1073741824 ? configuredMax : 10485760;
  const outputLog = createBoundedWorkerLog({ path: join(resolve(logs), "sync-worker-output.log"), maxBytes });
  const networkMarker = join(runtimeDir, "sync-worker.network-failure");
  fs.rmSync(networkMarker, { force: true });
  const log = (line, options) => {
    outputLog(line, options);
    if (/ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|ECONNREFUSED|getaddrinfo|network unreachable|fetch failed/i.test(line)) {
      try { fs.writeFileSync(networkMarker, "1\n"); } catch { /* Logging must not break child observation. */ }
    }
  };
  process.exitCode = await superviseWorker({ cwd, runtimeDir, metricsPath, log, thresholdMs,
    args: ["--import", new URL("./worker-crash-preload.mjs", import.meta.url).href, resolve(cwd, "scripts/run-sync-worker.mjs")] });
} else {
  console.error("Expected --run or --status"); process.exitCode = 2;
}
