import { randomUUID } from "node:crypto";
import os from "node:os";

export const RUNTIME_EXIT_CODES = Object.freeze({
  NORMAL: 0,
  LEASE_CONTENDED: 20,
  LEASE_LOST: 21,
  CONFIGURATION_INVALID: 22,
  DATABASE_UNAVAILABLE: 23,
});

const serviceKeyPattern = /^[A-Za-z0-9._:-]{3,160}$/;
const hostIdPattern = /^[A-Za-z0-9._:-]{1,120}$/;

function environmentBoolean(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function environmentInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function safeIdentifier(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

export function detectRuntimePlatform(environment = process.env, platform = process.platform) {
  if (environment.RENDER || environment.RENDER_SERVICE_NAME) return "Render";
  if (environment.TERMUX_VERSION || String(environment.PREFIX || "").includes("com.termux")) {
    return "AndroidTermux";
  }
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return "Unknown";
}

export function createRuntimeIdentity(environment = process.env, options = {}) {
  const hostname = safeIdentifier(options.hostname || os.hostname(), "unknown-host");
  const platform = options.platform || detectRuntimePlatform(environment, options.processPlatform);
  const renderHost = environment.RENDER_SERVICE_NAME
    ? `render-${environment.RENDER_SERVICE_NAME}`
    : null;
  const hostId = safeIdentifier(environment.NUVILOVIEW_HOST_ID || renderHost || hostname, hostname);

  return Object.freeze({
    hostId,
    hostname,
    platform,
    instanceId: options.instanceId || randomUUID(),
    pid: options.pid || process.pid,
    startedAt: options.startedAt || new Date(),
    appVersion: environment.NUVILOVIEW_VERSION || environment.npm_package_version || "0.1.0",
    runtimeVersion: process.version,
    commitSha:
      environment.NUVILOVIEW_COMMIT_SHA ||
      environment.RENDER_GIT_COMMIT ||
      environment.VERCEL_GIT_COMMIT_SHA ||
      null,
  });
}

export function getRuntimeConfig(environment = process.env) {
  const deploymentEnvironment = safeIdentifier(
    environment.NUVILOVIEW_DEPLOYMENT_ENV || "production",
    "production",
  );
  const config = {
    enabled: environmentBoolean(environment.NUVILOVIEW_DISTRIBUTED_SINGLETON, false),
    serviceKey:
      environment.NUVILOVIEW_SERVICE_KEY?.trim() ||
      `nuviloview.discord-bot.${deploymentEnvironment}`,
    ttlSeconds: environmentInteger(environment.NUVILOVIEW_LEASE_TTL_SECONDS, 45, 15, 600),
    renewSeconds: environmentInteger(environment.NUVILOVIEW_LEASE_RENEW_SECONDS, 15, 5, 300),
    heartbeatSeconds: environmentInteger(environment.NUVILOVIEW_HEARTBEAT_SECONDS, 15, 5, 300),
    proofSafetySeconds: environmentInteger(environment.NUVILOVIEW_LEASE_SAFETY_SECONDS, 5, 1, 60),
    heartbeatRetentionDays: environmentInteger(
      environment.NUVILOVIEW_HEARTBEAT_RETENTION_DAYS,
      30,
      1,
      365,
    ),
  };
  return Object.freeze(config);
}

export function validateRuntimeConfig(config, identity) {
  const errors = [];
  if (!serviceKeyPattern.test(config.serviceKey)) {
    errors.push("NUVILOVIEW_SERVICE_KEY must contain only letters, numbers, dot, colon, underscore, or hyphen.");
  }
  if (!hostIdPattern.test(identity.hostId)) {
    errors.push("NUVILOVIEW_HOST_ID must contain only letters, numbers, dot, colon, underscore, or hyphen.");
  }
  if (config.renewSeconds >= config.ttlSeconds) {
    errors.push("NUVILOVIEW_LEASE_RENEW_SECONDS must be lower than NUVILOVIEW_LEASE_TTL_SECONDS.");
  }
  if (config.heartbeatSeconds >= config.ttlSeconds) {
    errors.push("NUVILOVIEW_HEARTBEAT_SECONDS must be lower than NUVILOVIEW_LEASE_TTL_SECONDS.");
  }
  if (config.proofSafetySeconds >= config.ttlSeconds - config.renewSeconds) {
    errors.push("NUVILOVIEW_LEASE_SAFETY_SECONDS leaves no safe renewal window.");
  }
  return errors;
}

function rowsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function normalizeLease(row) {
  if (!row) return null;
  return {
    serviceKey: row.serviceKey,
    ownerInstanceId: row.ownerInstanceId || null,
    hostId: row.hostId || null,
    fencingToken: row.fencingToken == null ? null : String(row.fencingToken),
    leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt) : null,
    acquiredAt: row.acquiredAt ? new Date(row.acquiredAt) : null,
    renewedAt: row.renewedAt ? new Date(row.renewedAt) : null,
    dbNow: row.dbNow ? new Date(row.dbNow) : null,
  };
}

export function createRuntimeLeaseRepository(query) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");

  return Object.freeze({
    async acquire({ serviceKey, instanceId, hostId, ttlSeconds }) {
      const result = await query(
        `
          INSERT INTO "service_lease" (
            "serviceKey", "ownerInstanceId", "hostId", "fencingToken",
            "leaseExpiresAt", "acquiredAt", "renewedAt", "metadata"
          )
          VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}'::jsonb)
          ON CONFLICT ("serviceKey") DO UPDATE SET
            "ownerInstanceId" = EXCLUDED."ownerInstanceId",
            "hostId" = EXCLUDED."hostId",
            "fencingToken" = CASE
              WHEN "service_lease"."ownerInstanceId" = EXCLUDED."ownerInstanceId"
                THEN "service_lease"."fencingToken"
              ELSE "service_lease"."fencingToken" + 1
            END,
            "leaseExpiresAt" = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'),
            "acquiredAt" = CASE
              WHEN "service_lease"."ownerInstanceId" = EXCLUDED."ownerInstanceId"
                THEN "service_lease"."acquiredAt"
              ELSE CURRENT_TIMESTAMP
            END,
            "renewedAt" = CURRENT_TIMESTAMP,
            "metadata" = '{}'::jsonb
          WHERE "service_lease"."ownerInstanceId" IS NULL
             OR "service_lease"."leaseExpiresAt" <= CURRENT_TIMESTAMP
             OR "service_lease"."ownerInstanceId" = EXCLUDED."ownerInstanceId"
          RETURNING "serviceKey", "ownerInstanceId", "hostId", "fencingToken",
                    "leaseExpiresAt", "acquiredAt", "renewedAt", CURRENT_TIMESTAMP AS "dbNow"
        `,
        [serviceKey, instanceId, hostId, ttlSeconds],
      );
      return normalizeLease(rowsFromResult(result)[0]);
    },

    async renew({ serviceKey, instanceId, fencingToken, ttlSeconds }) {
      const result = await query(
        `
          UPDATE "service_lease"
          SET "leaseExpiresAt" = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'),
              "renewedAt" = CURRENT_TIMESTAMP
          WHERE "serviceKey" = $1
            AND "ownerInstanceId" = $2
            AND "fencingToken" = $3::bigint
            AND "leaseExpiresAt" > CURRENT_TIMESTAMP
          RETURNING "serviceKey", "ownerInstanceId", "hostId", "fencingToken",
                    "leaseExpiresAt", "acquiredAt", "renewedAt", CURRENT_TIMESTAMP AS "dbNow"
        `,
        [serviceKey, instanceId, fencingToken, ttlSeconds],
      );
      return normalizeLease(rowsFromResult(result)[0]);
    },

    async release({ serviceKey, instanceId, fencingToken }) {
      const result = await query(
        `
          UPDATE "service_lease"
          SET "ownerInstanceId" = NULL,
              "hostId" = NULL,
              "leaseExpiresAt" = CURRENT_TIMESTAMP,
              "renewedAt" = CURRENT_TIMESTAMP,
              "metadata" = '{}'::jsonb
          WHERE "serviceKey" = $1
            AND "ownerInstanceId" = $2
            AND "fencingToken" = $3::bigint
          RETURNING "serviceKey", "fencingToken", CURRENT_TIMESTAMP AS "dbNow"
        `,
        [serviceKey, instanceId, fencingToken],
      );
      return rowsFromResult(result).length === 1;
    },

    async getCurrentOwner(serviceKey) {
      const result = await query(
        `
          SELECT "serviceKey", "ownerInstanceId", "hostId", "fencingToken",
                 "leaseExpiresAt", "acquiredAt", "renewedAt", CURRENT_TIMESTAMP AS "dbNow"
          FROM "service_lease"
          WHERE "serviceKey" = $1
          LIMIT 1
        `,
        [serviceKey],
      );
      return normalizeLease(rowsFromResult(result)[0]);
    },

    async writeHeartbeat(heartbeat) {
      await query(
        `
          INSERT INTO "service_heartbeat" (
            "instanceId", "serviceKey", "hostId", "fencingToken", "platform",
            "hostname", "pid", "startedAt", "lastHeartbeatAt", "status", "leaseState",
            "appVersion", "runtimeVersion", "commitSha", "guildCount", "metadata", "stoppedAt"
          )
          VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
          ON CONFLICT ("instanceId") DO UPDATE SET
            "lastHeartbeatAt" = CURRENT_TIMESTAMP,
            "fencingToken" = EXCLUDED."fencingToken",
            "status" = EXCLUDED."status",
            "leaseState" = EXCLUDED."leaseState",
            "guildCount" = EXCLUDED."guildCount",
            "metadata" = EXCLUDED."metadata",
            "stoppedAt" = EXCLUDED."stoppedAt"
        `,
        [
          heartbeat.instanceId,
          heartbeat.serviceKey,
          heartbeat.hostId,
          heartbeat.fencingToken,
          heartbeat.platform,
          heartbeat.hostname,
          heartbeat.pid,
          heartbeat.startedAt,
          heartbeat.status,
          heartbeat.leaseState,
          heartbeat.appVersion,
          heartbeat.runtimeVersion,
          heartbeat.commitSha,
          heartbeat.guildCount,
          JSON.stringify(heartbeat.metadata || {}),
          heartbeat.stoppedAt || null,
        ],
      );
    },

    async cleanupHeartbeats({ serviceKey, retentionDays }) {
      const result = await query(
        `
          DELETE FROM "service_heartbeat" AS heartbeat
          WHERE heartbeat."serviceKey" = $1
            AND heartbeat."lastHeartbeatAt" < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM "service_lease" AS lease
              WHERE lease."serviceKey" = heartbeat."serviceKey"
                AND lease."ownerInstanceId" = heartbeat."instanceId"
            )
          RETURNING heartbeat."instanceId"
        `,
        [serviceKey, retentionDays],
      );
      return rowsFromResult(result).length;
    },
  });
}

function shortId(value) {
  if (!value) return "none";
  return String(value).length <= 12 ? String(value) : `${String(value).slice(0, 8)}…`;
}

export class RuntimeCoordinator {
  constructor({
    repository,
    config,
    identity,
    heartbeatData = () => ({}),
    onLeaseLost = async () => {},
    logger = console,
    monotonicNow = () => performance.now(),
  }) {
    this.repository = repository;
    this.config = config;
    this.identity = identity;
    this.heartbeatData = heartbeatData;
    this.onLeaseLost = onLeaseLost;
    this.logger = logger;
    this.monotonicNow = monotonicNow;
    this.fencingToken = null;
    this.leaseProofDeadline = 0;
    this.status = "Starting";
    this.leaseState = "Acquiring";
    this.leaseTimer = null;
    this.heartbeatTimer = null;
    this.renewing = false;
    this.heartbeatQueue = Promise.resolve(true);
    this.stopping = false;
    this.lost = false;
  }

  updateProofDeadline(lease) {
    const remaining = Math.max(
      0,
      lease.leaseExpiresAt.getTime() - lease.dbNow.getTime(),
    );
    this.leaseProofDeadline = this.monotonicNow() + remaining;
  }

  async acquire() {
    const lease = await this.repository.acquire({
      serviceKey: this.config.serviceKey,
      instanceId: this.identity.instanceId,
      hostId: this.identity.hostId,
      ttlSeconds: this.config.ttlSeconds,
    });
    if (!lease) {
      this.status = "LeaseContended";
      this.leaseState = "Contended";
      const owner = await this.repository.getCurrentOwner(this.config.serviceKey).catch(() => null);
      await this.recordNow().catch(() => {});
      this.logger.info(
        `[Singleton] lease acquisition rejected service=${this.config.serviceKey} host=${this.identity.hostId} currentOwner=${owner?.hostId || "unknown"}`,
      );
      return { acquired: false, owner };
    }

    this.fencingToken = lease.fencingToken;
    this.leaseState = "Owned";
    this.updateProofDeadline(lease);
    this.logger.info(
      `[Singleton] lease acquired service=${this.config.serviceKey} host=${this.identity.hostId} instance=${shortId(this.identity.instanceId)} fence=${this.fencingToken}`,
    );
    return { acquired: true, lease };
  }

  async start() {
    if (!this.fencingToken) throw new Error("Cannot start runtime coordination before acquiring the lease.");
    await this.recordNow();
    await this.repository
      .cleanupHeartbeats({
        serviceKey: this.config.serviceKey,
        retentionDays: this.config.heartbeatRetentionDays,
      })
      .catch((error) => this.logger.warn("[Heartbeat] retention cleanup failed", error));

    this.leaseTimer = setInterval(
      () => void this.renewOnce(),
      this.config.renewSeconds * 1_000,
    );
    this.heartbeatTimer = setInterval(
      () => void this.recordNow(),
      this.config.heartbeatSeconds * 1_000,
    );
    this.leaseTimer.unref?.();
    this.heartbeatTimer.unref?.();
  }

  setStatus(status, leaseState = this.leaseState) {
    this.status = status;
    this.leaseState = leaseState;
  }

  async renewOnce() {
    if (this.renewing || this.stopping || this.lost || !this.fencingToken) return false;
    this.renewing = true;
    try {
      const lease = await this.repository.renew({
        serviceKey: this.config.serviceKey,
        instanceId: this.identity.instanceId,
        fencingToken: this.fencingToken,
        ttlSeconds: this.config.ttlSeconds,
      });
      if (!lease) {
        await this.handleLeaseLost("renewal rejected");
        return false;
      }
      this.updateProofDeadline(lease);
      this.leaseState = "Owned";
      this.logger.debug?.(
        `[Singleton] lease renewed host=${this.identity.hostId} fence=${this.fencingToken}`,
      );
      return true;
    } catch (error) {
      this.logger.warn("[Singleton] lease renewal failed temporarily", error);
      const safetyDeadline =
        this.leaseProofDeadline - this.config.proofSafetySeconds * 1_000;
      if (this.monotonicNow() >= safetyDeadline) {
        await this.handleLeaseLost("ownership could not be proven before the safety deadline", error);
      }
      return false;
    } finally {
      this.renewing = false;
    }
  }

  async recordNow(overrides = {}) {
    const operation = this.heartbeatQueue.then(async () => {
      try {
        const dynamic = await this.heartbeatData();
        await this.repository.writeHeartbeat({
          ...this.identity,
          serviceKey: this.config.serviceKey,
          fencingToken: this.fencingToken,
          status: overrides.status || this.status,
          leaseState: overrides.leaseState || this.leaseState,
          guildCount: Number.isInteger(dynamic.guildCount) ? dynamic.guildCount : 0,
          metadata:
            dynamic.metadata && typeof dynamic.metadata === "object" && !Array.isArray(dynamic.metadata)
              ? dynamic.metadata
              : {},
          stoppedAt: overrides.stoppedAt || null,
        });
        return true;
      } catch (error) {
        this.logger.warn("[Heartbeat] update failed", error);
        return false;
      }
    });
    // Serialize writes so a slow periodic heartbeat can never overwrite the
    // final Stopped/LeaseLost state during shutdown.
    this.heartbeatQueue = operation.catch(() => false);
    return operation;
  }

  clearTimers() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.leaseTimer = null;
    this.heartbeatTimer = null;
  }

  async handleLeaseLost(reason, error = null) {
    if (this.lost || this.stopping) return;
    this.lost = true;
    this.clearTimers();
    this.status = "LeaseLost";
    this.leaseState = "Lost";
    this.logger.error(
      `[Singleton] lease lost service=${this.config.serviceKey} host=${this.identity.hostId} fence=${this.fencingToken} reason=${reason}`,
      error || "",
    );
    await this.recordNow({ status: "LeaseLost", leaseState: "Lost", stoppedAt: new Date() });
    await this.onLeaseLost({ reason, error });
  }

  async stop({ release = true, finalStatus = "Stopped" } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    this.clearTimers();
    if (!this.lost) {
      this.status = "Stopping";
      await this.recordNow({ status: "Stopping", leaseState: this.leaseState });
    }

    let released = false;
    if (release && !this.lost && this.fencingToken) {
      released = await this.repository
        .release({
          serviceKey: this.config.serviceKey,
          instanceId: this.identity.instanceId,
          fencingToken: this.fencingToken,
        })
        .catch((error) => {
          this.logger.warn("[Singleton] lease release failed; TTL will release it", error);
          return false;
        });
    }
    this.status = finalStatus;
    this.leaseState = released ? "Released" : this.lost ? "Lost" : "Unknown";
    await this.recordNow({
      status: this.status,
      leaseState: this.leaseState,
      stoppedAt: new Date(),
    });
  }
}
