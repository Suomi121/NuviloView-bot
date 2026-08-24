const severityRank = Object.freeze({ INFO: 0, WARNING: 1, CRITICAL: 2 });

function asDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function integer(environment, name, fallback, minimum, maximum) {
  const value = Number(environment[name]);
  return Number.isInteger(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
}

function secondsSince(value, now) {
  const date = asDate(value);
  return date ? Math.max(0, (now.getTime() - date.getTime()) / 1_000) : null;
}

function occurredWithin(value, now, windowSeconds) {
  const age = secondsSince(value, now);
  return age !== null && age <= windowSeconds;
}

function isNewer(left, right) {
  const leftDate = asDate(left);
  const rightDate = asDate(right);
  return Boolean(leftDate && (!rightDate || leftDate.getTime() > rightDate.getTime()));
}

function addIncident(incidents, severity, code, message) {
  incidents.push({ severity, code, message });
}

export function getOperationsMonitorConfig(environment = process.env) {
  const dbWarningMs = integer(environment, "NUVILOVIEW_MONITOR_DB_WARNING_MS", 750, 50, 30_000);
  const dbCriticalMs = integer(
    environment,
    "NUVILOVIEW_MONITOR_DB_CRITICAL_MS",
    2_000,
    dbWarningMs + 1,
    60_000,
  );
  const apiWarningMs = integer(environment, "NUVILOVIEW_MONITOR_API_WARNING_MS", 1_500, 100, 30_000);
  const apiCriticalMs = integer(
    environment,
    "NUVILOVIEW_MONITOR_API_CRITICAL_MS",
    5_000,
    apiWarningMs + 1,
    60_000,
  );
  const backupWarningHours = integer(
    environment,
    "NUVILOVIEW_MONITOR_BACKUP_WARNING_HOURS",
    36,
    1,
    8_760,
  );
  const backupCriticalHours = integer(
    environment,
    "NUVILOVIEW_MONITOR_BACKUP_CRITICAL_HOURS",
    72,
    backupWarningHours + 1,
    17_520,
  );
  const analyticsWarningMinutes = integer(
    environment,
    "NUVILOVIEW_MONITOR_ANALYTICS_WARNING_MINUTES",
    45,
    15,
    10_080,
  );
  const analyticsCriticalMinutes = integer(
    environment,
    "NUVILOVIEW_MONITOR_ANALYTICS_CRITICAL_MINUTES",
    120,
    analyticsWarningMinutes + 1,
    20_160,
  );
  return Object.freeze({
    dbWarningMs,
    dbCriticalMs,
    apiWarningMs,
    apiCriticalMs,
    backupWarningHours,
    backupCriticalHours,
    analyticsWarningMinutes,
    analyticsCriticalMinutes,
    discordEventWindowMinutes: integer(
      environment,
      "NUVILOVIEW_MONITOR_DISCORD_EVENT_WINDOW_MINUTES",
      15,
      1,
      1_440,
    ),
  });
}

export function evaluateOperationsSnapshot({
  now: nowValue = new Date(),
  runtime,
  db = {},
  api = null,
  backup = null,
  analytics = {},
  config,
}) {
  const now = asDate(nowValue) || new Date();
  const incidents = [];

  if (db.unavailable) {
    addIncident(incidents, "CRITICAL", "database_unavailable", "Database connectivity check failed.");
  } else if (Number(db.latencyMs) >= config.dbCriticalMs) {
    addIncident(incidents, "CRITICAL", "database_latency_critical", `Database query latency is ${Math.round(db.latencyMs)} ms.`);
  } else if (Number(db.latencyMs) >= config.dbWarningMs) {
    addIncident(incidents, "WARNING", "database_latency_warning", `Database query latency is ${Math.round(db.latencyMs)} ms.`);
  }

  if (runtime?.state === "Critical" || runtime?.state === "Unknown") {
    for (const incident of runtime.incidents || []) {
      addIncident(incidents, "CRITICAL", `runtime_${incident.code}`, incident.message);
    }
  } else if (runtime?.state === "Warning") {
    for (const incident of runtime.incidents || []) {
      addIncident(incidents, "WARNING", `runtime_${incident.code}`, incident.message);
    }
  }

  const owner = runtime?.ownerHeartbeat || null;
  const metadata = owner?.metadata && typeof owner.metadata === "object" ? owner.metadata : {};
  if (owner && metadata.discordReady === false && owner.status === "Running") {
    addIncident(incidents, "CRITICAL", "discord_not_ready", "The lease owner is running but Discord is not ready.");
  }
  const discordWindowSeconds = config.discordEventWindowMinutes * 60;
  if (occurredWithin(metadata.lastDiscordLoginFailureAt, now, discordWindowSeconds)) {
    addIncident(incidents, "CRITICAL", "discord_login_failure", "A Discord login failure occurred recently.");
  }
  if (occurredWithin(metadata.lastDiscordInvalidSessionAt, now, discordWindowSeconds)) {
    addIncident(incidents, "CRITICAL", "discord_invalid_session", "The Discord gateway session was invalidated recently.");
  }
  if (occurredWithin(metadata.lastDiscordRateLimitAt, now, discordWindowSeconds)) {
    addIncident(incidents, "WARNING", "discord_rate_limited", "A Discord REST rate limit occurred recently.");
  }
  if (
    occurredWithin(metadata.lastDiscordDisconnectAt, now, discordWindowSeconds) &&
    isNewer(metadata.lastDiscordDisconnectAt, metadata.lastDiscordResumeAt)
  ) {
    addIncident(incidents, "WARNING", "discord_reconnecting", "Discord disconnected and has not recorded a later resume yet.");
  }

  if (api?.configured) {
    if (api.authFailure) {
      addIncident(incidents, "CRITICAL", "api_monitor_auth_failed", "The Web API monitor credential was rejected.");
    } else if (!api.ok) {
      addIncident(incidents, "CRITICAL", "api_unavailable", `The Web API health check returned HTTP ${api.status || "unavailable"}.`);
    } else if (Number(api.latencyMs) >= config.apiCriticalMs) {
      addIncident(incidents, "CRITICAL", "api_latency_critical", `Web API latency is ${Math.round(api.latencyMs)} ms.`);
    } else if (Number(api.latencyMs) >= config.apiWarningMs) {
      addIncident(incidents, "WARNING", "api_latency_warning", `Web API latency is ${Math.round(api.latencyMs)} ms.`);
    }
  }

  if (!backup?.available) {
    addIncident(incidents, "WARNING", "backup_status_missing", "Backup status is unavailable to the monitor.");
  } else {
    const backupAgeSeconds = secondsSince(backup.updatedAt, now);
    const backupAgeHours = backupAgeSeconds === null ? Number.POSITIVE_INFINITY : backupAgeSeconds / 3_600;
    if (backup.status === "failed") {
      addIncident(incidents, "CRITICAL", "backup_failed", `The last backup failed during ${backup.stage || "an unknown stage"}.`);
    } else if (backup.status === "degraded") {
      addIncident(incidents, "WARNING", "backup_degraded", "The last backup did not reach every configured destination.");
    }
    if (["complete", "degraded"].includes(backup.status) && backup.restoreVerified !== true) {
      addIncident(incidents, "CRITICAL", "backup_restore_unverified", "The latest completed backup has no successful restore verification.");
    }
    if (backupAgeHours >= config.backupCriticalHours) {
      addIncident(incidents, "CRITICAL", "backup_stale_critical", `Backup status is ${Math.floor(backupAgeHours)} hours old.`);
    } else if (backupAgeHours >= config.backupWarningHours) {
      addIncident(incidents, "WARNING", "backup_stale_warning", `Backup status is ${Math.floor(backupAgeHours)} hours old.`);
    }
  }

  const guildCount = Number(owner?.guildCount || analytics.guildCount || 0);
  const analyticsSuccessAt = metadata.lastAnalyticsSuccessAt || analytics.lastObservedAt;
  const analyticsFailureAt = metadata.lastAnalyticsFailureAt;
  if (guildCount > 0) {
    const analyticsAgeSeconds = secondsSince(analyticsSuccessAt, now);
    const analyticsAgeMinutes = analyticsAgeSeconds === null ? Number.POSITIVE_INFINITY : analyticsAgeSeconds / 60;
    if (!analyticsSuccessAt || analyticsAgeMinutes >= config.analyticsCriticalMinutes) {
      addIncident(incidents, "CRITICAL", "analytics_ingestion_stale", "Analytics inventory has not completed within the critical window.");
    } else if (analyticsAgeMinutes >= config.analyticsWarningMinutes) {
      addIncident(incidents, "WARNING", "analytics_ingestion_delayed", `Analytics inventory is ${Math.floor(analyticsAgeMinutes)} minutes old.`);
    }
    if (isNewer(analyticsFailureAt, analyticsSuccessAt)) {
      addIncident(incidents, "WARNING", "analytics_ingestion_failed", "The latest Analytics inventory attempt failed.");
    }
  }

  const severity = incidents.reduce(
    (current, incident) => severityRank[incident.severity] > severityRank[current] ? incident.severity : current,
    "INFO",
  );
  return {
    severity,
    state: severity === "CRITICAL" ? "Critical" : severity === "WARNING" ? "Warning" : "Healthy",
    incidents,
  };
}

export function operationsIncidentFingerprint(result) {
  return `${result.severity}:${result.incidents.map((incident) => incident.code).sort().join(",")}`;
}

export function classifyOperationsTransition(previous, result) {
  const fingerprint = operationsIncidentFingerprint(result);
  const changed = previous?.fingerprint !== fingerprint;
  return {
    fingerprint,
    changed,
    recovered: Boolean(changed && previous && previous.severity !== "INFO" && result.severity === "INFO"),
  };
}
