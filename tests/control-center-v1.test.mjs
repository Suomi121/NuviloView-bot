import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const controlScript = join(projectRoot, "nuviloctl.ps1");
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

function runControl(args, options = {}) {
  return spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", controlScript, ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: options.timeout ?? 15_000,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
    },
  );
}

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "nuvilo-control-center-"));
  const now = Date.now();
  mkdirSync(join(root, "data", "runtime"), { recursive: true });
  writeFileSync(join(root, ".env.local"), "SYNC_WORKER_ENABLED=true\n", "utf8");
  const providers = {
    supabase: {
      providerId: "supabase",
      required: true,
      enabled: true,
      healthStatus: "HEALTHY",
      circuitState: "CLOSED",
      pending: 0,
      processing: 0,
      retry: 0,
      synced: 12,
      deadLetter: 0,
      lastSuccessAt: now - 2_000,
      lastFailureAt: null,
      syncedTotal: 240,
      queryCount: 120,
    },
    turso: {
      providerId: "turso",
      required: true,
      enabled: true,
      healthStatus: "HEALTHY",
      circuitState: "CLOSED",
      pending: 0,
      processing: 0,
      retry: 0,
      synced: 12,
      deadLetter: 0,
      lastSuccessAt: now - 1_000,
      lastFailureAt: now - 60_000,
      syncedTotal: 238,
      queryCount: 119,
    },
    neon: {
      providerId: "neon",
      required: false,
      enabled: false,
      healthStatus: "DISABLED",
      circuitState: "CLOSED",
      pending: 0,
      processing: 0,
      retry: 0,
      synced: 0,
      deadLetter: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      syncedTotal: 0,
      queryCount: 0,
    },
  };
  const sync = {
    schemaVersion: 2,
    mode: "MULTI_DB_SYNC_V1",
    generatedAt: now,
    workerStatus: "RUNNING",
    workerHealth: "HEALTHY",
    providers,
    cloudComplete: { complete: 12, total: 12 },
    sqlite: {
      status: "HEALTHY",
      schemaVersion: 7,
      journalMode: "wal",
      storage: { totalBytes: 1_048_576, databaseBytes: 786_432, walBytes: 262_144 },
      integrity: { ok: true, check: "quick_check", messages: ["ok"], checkedAt: now },
    },
    analyticsCompaction: {
      enabled: true,
      guildCount: 2,
      rawEventsSeen: 100,
      providerWrites: 20,
      providerWriteReductionRatio: 80,
      snapshotsChanged: 10,
      snapshotsSkipped: 4,
      lastBuiltAt: now - 3_000,
    },
    startedAt: now - 300_000,
    ...overrides.sync,
  };
  if (overrides.providers) sync.providers = { ...providers, ...overrides.providers };
  const runtime = {
    schemaVersion: 1,
    runtimeMode: "LOCAL_FIRST",
    neon: "OFFLINE",
    configured: true,
    lastSuccessfulQueryAt: null,
    lastFailureAt: now - 60_000,
    discordReady: true,
    guildCount: 11,
    updatedAt: now,
    ...overrides.runtime,
  };
  writeJson(join(root, "data", "runtime", "sync-worker-health.json"), sync);
  writeJson(join(root, "data", "runtime", "neon-runtime-health.json"), runtime);
  return { root, now };
}

function parseJsonResult(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function captureTree(root) {
  const records = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        const value = readFileSync(path);
        records.push({
          path: path.slice(root.length),
          size: statSync(path).size,
          hash: createHash("sha256").update(value).digest("hex"),
        });
      }
    }
  };
  walk(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

test("Control Center help and version commands are available", () => {
  const help = runControl(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /status --watch/);
  assert.match(help.stdout, /read-only/i);
  const version = runControl(["version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /v1\.0\.0/);
});

test("status --json returns healthy runtime, providers, queue, and analytics", () => {
  const fixture = createFixture();
  const value = parseJsonResult(runControl(["status", "--json", "--project-root", fixture.root]));
  assert.equal(value.overall, "HEALTHY");
  assert.equal(value.runtime.bot, "RUNNING");
  assert.equal(value.runtime.worker, "RUNNING");
  assert.equal(value.runtime.discord, "CONNECTED");
  assert.equal(value.runtime.sqlite, "HEALTHY");
  assert.equal(value.runtime.cloudComplete.percent, 100);
  assert.equal(value.providers.find(({ id }) => id === "supabase").circuit, "CLOSED");
  assert.equal(value.providers.find(({ id }) => id === "turso").state, "HEALTHY");
  assert.equal(value.providers.find(({ id }) => id === "neon").state, "OPTIONAL");
  assert.equal(value.queue.pending, 0);
  assert.equal(value.queue.percent, 0);
  assert.equal(value.queue.lastSuccessfulSync, fixture.now - 2_000);
  assert.equal(value.analytics.rawEventsSeen, 100);
  assert.equal(value.analytics.reductionRatio, 80);
  assert.equal(value.readOnly, true);
});

test("human status renders every required section and HP-style usage bars", () => {
  const { root } = createFixture();
  const result = runControl(["status", "--once", "--no-color", "--project-root", root]);
  assert.equal(result.status, 0, result.stderr);
  for (const heading of [
    "Runtime Overview",
    "Provider Status",
    "Queue / Sync",
    "Usage / Quota",
    "Current Activity",
    "Analytics Summary",
  ]) assert.match(result.stdout, new RegExp(heading.replace("/", "\\/")));
  assert.match(result.stdout, /[█░]{12,}/u);
  assert.match(result.stdout, /Supabase/);
  assert.match(result.stdout, /Turso/);
  assert.match(result.stdout, /Neon/);
});

test("missing and malformed snapshots remain readable and report degraded data", () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "nuvilo-control-missing-"));
  const missing = parseJsonResult(runControl(["status", "--json", "--project-root", missingRoot]));
  assert.equal(missing.overall, "OFFLINE");
  assert.equal(missing.sources.sync.error, "missing");
  assert.ok(missing.warnings.length >= 2);

  mkdirSync(join(missingRoot, "data", "runtime"), { recursive: true });
  writeFileSync(join(missingRoot, "data", "runtime", "sync-worker-health.json"), "{broken", "utf8");
  const malformed = parseJsonResult(runControl(["status", "--json", "--project-root", missingRoot]));
  assert.equal(malformed.sources.sync.error, "invalid_json");
  assert.equal(malformed.readOnly, true);
});

test("provider circuit and DLQ states affect overall health correctly", () => {
  const degradedFixture = createFixture({
    providers: {
      turso: {
        providerId: "turso",
        required: true,
        enabled: true,
        healthStatus: "DEGRADED",
        circuitState: "OPEN",
        pending: 3,
        processing: 0,
        retry: 3,
        synced: 9,
        deadLetter: 0,
        lastSuccessAt: Date.now() - 20_000,
        lastFailureAt: Date.now() - 1_000,
        syncedTotal: 200,
        queryCount: 100,
      },
    },
  });
  const degraded = parseJsonResult(runControl(["status", "--json", "--project-root", degradedFixture.root]));
  assert.equal(degraded.overall, "DEGRADED");
  assert.equal(degraded.providers.find(({ id }) => id === "turso").circuit, "OPEN");
  assert.equal(degraded.queue.retry, 3);
  assert.equal(degraded.queue.activity, "recovery / circuit open");

  const criticalFixture = createFixture({
    providers: {
      supabase: {
        providerId: "supabase",
        required: true,
        enabled: true,
        healthStatus: "DEGRADED",
        circuitState: "CLOSED",
        pending: 0,
        processing: 0,
        retry: 0,
        synced: 9,
        deadLetter: 1,
        lastSuccessAt: Date.now() - 20_000,
        lastFailureAt: Date.now() - 1_000,
        syncedTotal: 200,
        queryCount: 100,
      },
    },
  });
  const critical = parseJsonResult(runControl(["status", "--json", "--project-root", criticalFixture.root]));
  assert.equal(critical.overall, "CRITICAL");
  assert.equal(critical.queue.deadLetter, 1);
});

test("a disabled required provider cannot be reported as healthy", () => {
  const fixture = createFixture({
    providers: {
      turso: {
        providerId: "turso",
        required: true,
        enabled: false,
        healthStatus: "DISABLED",
        circuitState: "CLOSED",
        pending: 0,
        processing: 0,
        retry: 0,
        synced: 0,
        deadLetter: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        syncedTotal: 0,
        queryCount: 0,
      },
    },
  });
  const value = parseJsonResult(runControl(["status", "--json", "--project-root", fixture.root]));
  assert.equal(value.providers.find(({ id }) => id === "turso").state, "DISABLED");
  assert.equal(value.overall, "DEGRADED");
});

test("watch mode refreshes repeatedly and exits cleanly for bounded diagnostics", () => {
  const { root } = createFixture();
  const result = runControl([
    "status",
    "--watch",
    "--interval",
    "1",
    "--iterations",
    "2",
    "--no-color",
    "--project-root",
    root,
  ], { timeout: 8_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/NuviloView Control Center/g) ?? []).length, 2);
  assert.match(result.stdout, /--- refresh ---/);
});

test("status is read-only for all inspected fixture files", () => {
  const { root } = createFixture();
  const before = captureTree(root);
  const result = runControl(["status", "--json", "--project-root", root]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(captureTree(root), before);
});

test("PowerShell implementation excludes mutating and network commands", () => {
  const files = [
    "nuviloctl.ps1",
    "Windows/ControlCenter/nuviloctl.ps1",
    "Windows/ControlCenter/lib/Data.ps1",
    "Windows/ControlCenter/lib/State.ps1",
    "Windows/ControlCenter/lib/Render.ps1",
  ];
  const source = files.map((path) => readFileSync(join(projectRoot, path), "utf8")).join("\n");
  assert.doesNotMatch(source, /\b(?:Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Start-Process|Stop-Process|Invoke-WebRequest|Invoke-RestMethod)\b/i);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
});

test("all Control Center PowerShell files parse successfully", () => {
  const paths = [
    controlScript,
    join(projectRoot, "Windows", "ControlCenter", "nuviloctl.ps1"),
    join(projectRoot, "Windows", "ControlCenter", "lib", "Data.ps1"),
    join(projectRoot, "Windows", "ControlCenter", "lib", "State.ps1"),
    join(projectRoot, "Windows", "ControlCenter", "lib", "Render.ps1"),
  ];
  for (const path of paths) {
    const escapedPath = path.replaceAll("'", "''");
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference='Stop'; [void][ScriptBlock]::Create([IO.File]::ReadAllText('${escapedPath}'))`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});
