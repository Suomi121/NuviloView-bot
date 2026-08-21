const severityRank = Object.freeze({ Healthy: 0, Warning: 1, Critical: 2, Unknown: 3 });

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function heartbeatAgeSeconds(heartbeat, now) {
  const last = asDate(heartbeat?.lastHeartbeatAt);
  return last ? Math.max(0, (now.getTime() - last.getTime()) / 1_000) : Number.POSITIVE_INFINITY;
}

function addIncident(incidents, state, code, message) {
  incidents.push({ state, code, message });
}

export function getRuntimeMonitorConfig(environment = process.env) {
  const integer = (name, fallback, minimum, maximum) => {
    const value = Number(environment[name]);
    return Number.isInteger(value)
      ? Math.min(Math.max(value, minimum), maximum)
      : fallback;
  };
  const warningSeconds = integer("NUVILOVIEW_MONITOR_WARNING_SECONDS", 45, 15, 3600);
  const criticalSeconds = integer("NUVILOVIEW_MONITOR_CRITICAL_SECONDS", 90, warningSeconds + 1, 7200);
  return Object.freeze({
    serviceKey:
      environment.NUVILOVIEW_SERVICE_KEY?.trim() ||
      `nuviloview.discord-bot.${environment.NUVILOVIEW_DEPLOYMENT_ENV?.trim() || "production"}`,
    warningSeconds,
    criticalSeconds,
    restartWindowMinutes: integer("NUVILOVIEW_MONITOR_RESTART_WINDOW_MINUTES", 10, 1, 1440),
    restartThreshold: integer("NUVILOVIEW_MONITOR_RESTART_THRESHOLD", 5, 2, 100),
    contentionThreshold: integer("NUVILOVIEW_MONITOR_CONTENTION_THRESHOLD", 5, 2, 100),
    intervalSeconds: integer("NUVILOVIEW_MONITOR_INTERVAL_SECONDS", 30, 15, 3600),
  });
}

/**
 * @param {{
 *   dbNow?: Date | string | null,
 *   lease?: any,
 *   heartbeats?: any[],
 *   config: any,
 *   dbUnavailable?: boolean
 * }} snapshot
 */
export function evaluateRuntimeSnapshot({ dbNow, lease, heartbeats = [], config, dbUnavailable = false }) {
  if (dbUnavailable) {
    return {
      state: "Unknown",
      incidents: [{ state: "Unknown", code: "database_unavailable", message: "Runtime monitor cannot query the database." }],
      ownerHeartbeat: null,
      heartbeatAgeSeconds: null,
    };
  }

  const now = asDate(dbNow) || new Date();
  const incidents = [];
  const activeLease = Boolean(
    lease?.ownerInstanceId &&
      asDate(lease.leaseExpiresAt) &&
      asDate(lease.leaseExpiresAt).getTime() > now.getTime(),
  );
  const ownerHeartbeat = activeLease
    ? heartbeats.find(
        (heartbeat) =>
          heartbeat.instanceId === lease.ownerInstanceId &&
          String(heartbeat.fencingToken) === String(lease.fencingToken),
      ) || null
    : null;
  const ownerAge = ownerHeartbeat ? heartbeatAgeSeconds(ownerHeartbeat, now) : null;

  if (!activeLease) {
    addIncident(incidents, "Critical", "lease_owner_missing", "No unexpired runtime lease owner exists.");
    const freshWithoutLease = heartbeats.filter(
      (heartbeat) =>
        ["Starting", "Running"].includes(heartbeat.status) &&
        heartbeatAgeSeconds(heartbeat, now) <= config.criticalSeconds,
    );
    if (freshWithoutLease.length) {
      addIncident(
        incidents,
        "Critical",
        "heartbeat_without_lease",
        `${freshWithoutLease.length} active heartbeat(s) exist without a valid lease owner.`,
      );
    }
  } else if (!ownerHeartbeat) {
    addIncident(incidents, "Critical", "lease_without_heartbeat", "The lease owner has no matching heartbeat.");
  } else if (ownerAge > config.criticalSeconds) {
    addIncident(incidents, "Critical", "heartbeat_stale", `The owner heartbeat is ${Math.floor(ownerAge)} seconds old.`);
  } else if (ownerAge > config.warningSeconds) {
    addIncident(incidents, "Warning", "heartbeat_delayed", `The owner heartbeat is delayed by ${Math.floor(ownerAge)} seconds.`);
  }

  if (ownerHeartbeat && !["Starting", "Running"].includes(ownerHeartbeat.status)) {
    addIncident(incidents, "Critical", "owner_not_running", `The lease owner reports status ${ownerHeartbeat.status}.`);
  }
  if (ownerHeartbeat && ownerHeartbeat.leaseState !== "Owned") {
    addIncident(incidents, "Critical", "owner_lease_state_mismatch", `The lease owner reports lease state ${ownerHeartbeat.leaseState}.`);
  }

  const freshRunning = heartbeats.filter(
    (heartbeat) =>
      ["Starting", "Running"].includes(heartbeat.status) &&
      heartbeatAgeSeconds(heartbeat, now) <= config.criticalSeconds,
  );
  const nonOwnerRunning = freshRunning.filter(
    (heartbeat) => !ownerHeartbeat || heartbeat.instanceId !== ownerHeartbeat.instanceId,
  );
  if (nonOwnerRunning.length) {
    addIncident(
      incidents,
      "Critical",
      "duplicate_active_instances",
      `${nonOwnerRunning.length} fresh non-owner instance(s) report an active state.`,
    );
  }

  const instancesByHost = new Map();
  for (const heartbeat of freshRunning) {
    const entries = instancesByHost.get(heartbeat.hostId) || new Set();
    entries.add(heartbeat.instanceId);
    instancesByHost.set(heartbeat.hostId, entries);
  }
  const duplicateHosts = [...instancesByHost].filter(([, instances]) => instances.size > 1);
  if (duplicateHosts.length) {
    addIncident(
      incidents,
      "Warning",
      "duplicate_host_instance",
      `Multiple fresh process instances share hostId: ${duplicateHosts.map(([hostId]) => hostId).join(", ")}.`,
    );
  }

  const restartCutoff = now.getTime() - config.restartWindowMinutes * 60_000;
  const recentStarts = heartbeats.filter(
    (heartbeat) =>
      heartbeat.status !== "LeaseContended" &&
      (asDate(heartbeat.startedAt)?.getTime() || 0) >= restartCutoff,
  );
  if (recentStarts.length >= config.restartThreshold) {
    addIncident(
      incidents,
      "Warning",
      "restart_storm",
      `${recentStarts.length} instances started within ${config.restartWindowMinutes} minutes.`,
    );
  }

  const recentContentions = heartbeats.filter(
    (heartbeat) =>
      heartbeat.status === "LeaseContended" &&
      (asDate(heartbeat.startedAt)?.getTime() || 0) >= restartCutoff,
  );
  if (recentContentions.length >= config.contentionThreshold) {
    addIncident(
      incidents,
      "Warning",
      "lease_contention_repeated",
      `${recentContentions.length} lease contentions occurred within ${config.restartWindowMinutes} minutes.`,
    );
  }

  const recentOwnedFences = new Set(
    recentStarts
      .filter((heartbeat) => heartbeat.fencingToken != null)
      .map((heartbeat) => String(heartbeat.fencingToken)),
  );
  if (recentOwnedFences.size >= 3) {
    addIncident(
      incidents,
      "Warning",
      "owner_flapping",
      `${recentOwnedFences.size} ownership generations appeared within ${config.restartWindowMinutes} minutes.`,
    );
  }

  const state = incidents.length
    ? incidents.reduce(
        (current, incident) =>
          severityRank[incident.state] > severityRank[current] ? incident.state : current,
        "Healthy",
      )
    : "Healthy";

  return {
    state,
    incidents,
    ownerHeartbeat,
    heartbeatAgeSeconds: ownerAge,
  };
}

export function runtimeIncidentFingerprint(result) {
  return `${result.state}:${result.incidents.map((incident) => incident.code).sort().join(",")}`;
}

export function evaluateLegacyBotHeartbeat({ dbNow, heartbeat, maximumAgeSeconds = 180 }) {
  const now = asDate(dbNow) || new Date();
  const lastSeenAt = asDate(heartbeat?.lastSeenAt);
  const age = lastSeenAt ? Math.max(0, (now.getTime() - lastSeenAt.getTime()) / 1_000) : null;
  const incidents = [];
  if (!heartbeat) {
    addIncident(incidents, "Critical", "legacy_heartbeat_missing", "The legacy Bot heartbeat row is missing.");
  } else if (heartbeat.stoppedAt) {
    addIncident(incidents, "Critical", "legacy_heartbeat_stopped", "The Bot reports a stopped state.");
  } else if (age == null || age > maximumAgeSeconds) {
    addIncident(incidents, "Critical", "legacy_heartbeat_stale", `The Bot heartbeat is ${age == null ? "unavailable" : `${Math.floor(age)} seconds old`}.`);
  }
  return {
    state: incidents.length ? "Critical" : "Healthy",
    incidents,
    ownerHeartbeat: heartbeat
      ? {
          ...heartbeat,
          instanceId: "legacy-primary",
          hostId: "legacy-unidentified",
          status: heartbeat.stoppedAt ? "Stopped" : "Running",
          leaseState: "Unknown",
          metadata: {},
        }
      : null,
    heartbeatAgeSeconds: age,
  };
}
