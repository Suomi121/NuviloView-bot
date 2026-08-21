import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  classifyOperationsTransition,
  evaluateOperationsSnapshot,
  getOperationsMonitorConfig,
} from "../lib/operations-monitor.mjs";
import {
  evaluateLegacyBotHeartbeat,
  evaluateRuntimeSnapshot,
  getRuntimeMonitorConfig,
} from "../lib/runtime-monitor.mjs";

if (!process.env.DATABASE_URL) {
  console.error("[Monitor] DATABASE_URL is required.");
  process.exit(2);
}

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const jsonOutput = args.has("--json");
const config = getRuntimeMonitorConfig(process.env);
const operationsConfig = getOperationsMonitorConfig(process.env);
const expectSingleton = ["1", "true", "yes", "on"].includes(
  String(
    process.env.NUVILOVIEW_MONITOR_EXPECT_SINGLETON ??
      process.env.NUVILOVIEW_DISTRIBUTED_SINGLETON ??
      "false",
  ).trim().toLowerCase(),
);
const legacyHeartbeatMaximumAgeSeconds = Number.isInteger(Number(process.env.BOT_HEARTBEAT_MAX_AGE_SECONDS))
  ? Math.min(Math.max(Number(process.env.BOT_HEARTBEAT_MAX_AGE_SECONDS), 60), 3_600)
  : 180;
const statePath = path.resolve(
  process.env.NUVILOVIEW_MONITOR_STATE_FILE || "data/runtime-monitor/state.json",
);
const logPath = path.resolve(
  process.env.NUVILOVIEW_MONITOR_LOG_FILE || "logs/runtime-monitor.log",
);
const webhookUrl =
  process.env.NUVILOVIEW_MONITOR_WEBHOOK_URL?.trim() ||
  process.env.ALERT_WEBHOOK_URL?.trim() ||
  null;
const monitorHostId = process.env.NUVILOVIEW_MONITOR_HOST_ID?.trim() || "external-monitor";
const backupStatusPath = path.resolve(
  process.env.NUVILOVIEW_MONITOR_BACKUP_STATUS_FILE || "logs/backup-status.json",
);
const webMonitorUrl = process.env.NUVILOVIEW_MONITOR_WEB_URL?.trim() || null;
const webMonitorToken = process.env.BOT_MONITOR_TOKEN?.trim() || null;
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

async function loadSnapshot() {
  const startedAt = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const clock = await client.query('SELECT CURRENT_TIMESTAMP AS "dbNow"');
    const dbLatencyMs = performance.now() - startedAt;
    const lease = await client.query(
        `SELECT "serviceKey", "ownerInstanceId", "hostId", "fencingToken", "leaseExpiresAt", "acquiredAt", "renewedAt"
         FROM "service_lease" WHERE "serviceKey" = $1 LIMIT 1`,
        [config.serviceKey],
      );
    const heartbeats = await client.query(
        `SELECT "instanceId", "serviceKey", "hostId", "fencingToken", "platform", "startedAt",
                "lastHeartbeatAt", "status", "leaseState", "appVersion", "guildCount", "metadata", "stoppedAt"
         FROM "service_heartbeat"
         WHERE "serviceKey" = $1
           AND "lastHeartbeatAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
         ORDER BY "lastHeartbeatAt" DESC
         LIMIT 500`,
        [config.serviceKey],
      );
    const security = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE "severity" = 'Critical' AND "status" = 'Open')::int AS "openCritical",
           COUNT(*) FILTER (
             WHERE "severity" = 'High'
               AND "lastDetectedAt" >= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
           )::int AS "recentHigh"
         FROM "security_incident"`,
      );
    const analytics = await client.query(
        `SELECT MAX("checkedAt") AS "lastObservedAt",
                COUNT(DISTINCT "guildId")::int AS "guildCount"
         FROM "bot_channel_access"`,
      );
    const legacyHeartbeat = await client.query(
        `SELECT "lastSeenAt", "startedAt", "guildCount", "stoppedAt"
         FROM "bot_heartbeat"
         WHERE "id" = 'primary'
         LIMIT 1`,
      );
    await client.query("COMMIT");
    return {
      dbNow: clock.rows[0]?.dbNow,
      lease: lease.rows[0] || null,
      heartbeats: heartbeats.rows,
      security: security.rows[0] || { openCritical: 0, recentHigh: 0 },
      analytics: analytics.rows[0] || { lastObservedAt: null, guildCount: 0 },
      legacyHeartbeat: legacyHeartbeat.rows[0] || null,
      dbLatencyMs,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function loadBackupStatus() {
  try {
    const status = JSON.parse((await readFile(backupStatusPath, "utf8")).replace(/^\uFEFF/, ""));
    return {
      available: true,
      status: typeof status.status === "string" ? status.status : "unknown",
      stage: typeof status.stage === "string" ? status.stage : null,
      updatedAt: status.updatedAt || status.attemptedAt || null,
      restoreVerified: status.restoreVerified === true,
    };
  } catch {
    return { available: false };
  }
}

async function probeWebApi() {
  if (!webMonitorUrl) return { configured: false };
  if (!webMonitorToken) return { configured: true, ok: false, authFailure: true, status: null, latencyMs: 0 };
  const url = new URL(webMonitorUrl);
  url.searchParams.set("token", webMonitorToken);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return {
      configured: true,
      ok: response.ok,
      authFailure: response.status === 401 || response.status === 403,
      status: response.status,
      latencyMs: performance.now() - startedAt,
    };
  } catch {
    return {
      configured: true,
      ok: false,
      authFailure: false,
      status: null,
      latencyMs: performance.now() - startedAt,
    };
  }
}

async function readIncidentState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeIncidentState(value) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, statePath);
}

async function logTransition(entry) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function notify(result, recovered) {
  if (!webhookUrl) return;
  const title = recovered
    ? "NuviloView operations recovered"
    : `NuviloView operations ${result.severity}`;
  const description = result.incidents.length
    ? result.incidents.map((incident) => `• ${incident.message}`).join("\n").slice(0, 3500)
    : "Bot, database, API, backup, singleton, Security and Analytics checks are healthy.";
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "NuviloView Operations Monitor",
      allowed_mentions: { parse: [] },
      embeds: [{
        title,
        description,
        color: recovered ? 0x22c55e : result.severity === "WARNING" ? 0xf59e0b : 0xef4444,
        footer: { text: `service=${config.serviceKey} monitor=${monitorHostId}` },
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
}

async function checkOnce() {
  const [backup, api] = await Promise.all([loadBackupStatus(), probeWebApi()]);
  let runtimeResult;
  let snapshot = null;
  let db = { unavailable: false, latencyMs: 0 };
  try {
    snapshot = await loadSnapshot();
    db = { unavailable: false, latencyMs: snapshot.dbLatencyMs };
    runtimeResult = expectSingleton
      ? evaluateRuntimeSnapshot({ ...snapshot, config })
      : evaluateLegacyBotHeartbeat({
          dbNow: snapshot.dbNow,
          heartbeat: snapshot.legacyHeartbeat,
          maximumAgeSeconds: legacyHeartbeatMaximumAgeSeconds,
        });
  } catch (error) {
    db = { unavailable: true, latencyMs: 0 };
    runtimeResult = evaluateRuntimeSnapshot({ config, dbUnavailable: true });
    console.error(`[Monitor] database check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const result = evaluateOperationsSnapshot({
    runtime: runtimeResult,
    db,
    api,
    backup,
    security: snapshot?.security || {},
    analytics: snapshot?.analytics || {},
    config: operationsConfig,
  });

  const previous = await readIncidentState();
  const { fingerprint, changed, recovered } = classifyOperationsTransition(previous, result);
  const notificationRecovered = changed ? Boolean(recovered) : Boolean(previous?.notificationRecovered);
  const entry = {
    checkedAt: new Date().toISOString(),
    monitorHostId,
    serviceKey: config.serviceKey,
    state: result.state,
    severity: recovered ? "RECOVERY" : result.severity,
    incidents: result.incidents.map(({ severity, code, message }) => ({ severity, code, message })),
    ownerHostId: snapshot?.lease?.hostId || null,
    ownerInstanceId: snapshot?.lease?.ownerInstanceId
      ? `${String(snapshot.lease.ownerInstanceId).slice(0, 8)}…`
      : null,
    heartbeatAgeSeconds: runtimeResult.heartbeatAgeSeconds == null
      ? null
      : Math.floor(runtimeResult.heartbeatAgeSeconds),
    dbLatencyMs: db.unavailable ? null : Math.round(db.latencyMs),
    apiStatus: api.configured ? api.status : null,
    apiLatencyMs: api.configured ? Math.round(api.latencyMs) : null,
    backupStatus: backup.available ? backup.status : "unavailable",
  };

  let notificationPending = false;
  if (changed) {
    await logTransition(entry).catch((error) =>
      console.error(`[Monitor] local log write failed: ${error.message}`),
    );
  }
  const shouldNotify = Boolean(
    webhookUrl &&
      (previous?.notificationPending || (changed && (result.severity !== "INFO" || previous))),
  );
  if (shouldNotify) {
    try {
      await notify(result, notificationRecovered);
    } catch (error) {
      notificationPending = true;
      console.error(`[Monitor] alert delivery failed: ${error.message}`);
    }
  }
  await writeIncidentState({
    fingerprint,
    state: result.state,
    severity: result.severity,
    changedAt: changed ? entry.checkedAt : previous?.changedAt || entry.checkedAt,
    lastCheckedAt: entry.checkedAt,
    notificationPending,
    notificationRecovered: notificationPending ? notificationRecovered : false,
  });

  if (jsonOutput || !watch) console.log(JSON.stringify(entry));
  else if (changed) console.log(`[Monitor] state changed to ${result.severity}`);
  return result.state;
}

let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

let lastState = "Unknown";
try {
  do {
    lastState = await checkOnce();
    if (!watch || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1_000));
  } while (!stopping);
} finally {
  await pool.end();
}
if (!watch && (lastState === "Critical" || lastState === "Unknown")) process.exitCode = 1;
