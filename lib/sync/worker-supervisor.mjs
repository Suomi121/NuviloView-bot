import fs from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { constants } from "node:os";
import { createWorkerRedactor } from "./worker-diagnostics.mjs";

function read(path) { try { return fs.readFileSync(path, "utf8"); } catch { return ""; } }
function json(path) { try { return JSON.parse(read(path)); } catch { return null; } }
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch { return null; }
  const stat = read(`/proc/${pid}/stat`);
  if (process.platform === "linux") {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!stat || ["Z", "X"].includes(fields[0])) return null;
    return { pid, start: fields[19], command: read(`/proc/${pid}/cmdline`).split("\0") };
  }
  return { pid, start: null, command: [] };
}

export function heartbeatThreshold(env = process.env) {
  const interval = Number(env.SYNC_METRICS_INTERVAL_MS ?? 30000);
  return Math.max(120000, 4 * (Number.isFinite(interval) && interval > 0 ? interval : 30000));
}

export function evaluateWorkerState({ identity, expected, heartbeatAt, startedAt = 0, now = Date.now(), thresholdMs = 120000 }) {
  if (!identity) return "STOPPED";
  if (!expected || expected.pid !== identity.pid ||
      (expected.start !== null && expected.start !== identity.start)) return "DEGRADED";
  if (now - startedAt < thresholdMs && !(heartbeatAt >= startedAt)) return "STARTING";
  return Number.isFinite(heartbeatAt) && heartbeatAt >= startedAt && heartbeatAt <= now + 5000 &&
    now - heartbeatAt <= thresholdMs ? "RUNNING" : "DEGRADED";
}

export function inspectWorker({ runtimeDir, metricsPath, thresholdMs, now = Date.now(), identityReader = processIdentity }) {
  const pid = Number(read(join(runtimeDir, "sync-worker.pid")).trim());
  const expected = json(join(runtimeDir, "sync-worker.identity.json"));
  const metrics = json(metricsPath);
  const heartbeatAt = Number(metrics?.generatedAt ?? metrics?.timestamp);
  const identity = identityReader(pid);
  return { pid: pid || null, state: evaluateWorkerState({ identity, expected, heartbeatAt,
    startedAt: expected?.startedAt ?? 0, thresholdMs, now }), heartbeatAt: heartbeatAt || null };
}

export function createBoundedWorkerLog({ path, env = process.env, maxBytes = 10485760, archives = 3 }) {
  const redact = createWorkerRedactor(env);
  let windowStart = Date.now(), count = 0, suppressed = 0;
  function append(text) {
    let data = `${new Date().toISOString()} ${redact(text).slice(0, 16000)}\n`;
    if (Buffer.byteLength(data) > maxBytes) {
      data = `${new Date().toISOString()} [supervisor] oversized log entry omitted\n`;
    }
    if ((fs.existsSync(path) ? fs.statSync(path).size : 0) + Buffer.byteLength(data) > maxBytes) {
      for (let i = archives; i >= 1; i--) {
        const old = i === 1 ? path : `${path}.${i - 1}`;
        const dest = `${path}.${i}`;
        if (fs.existsSync(old)) { if (fs.existsSync(dest)) fs.unlinkSync(dest); fs.renameSync(old, dest); }
      }
    }
    fs.appendFileSync(path, data, { mode: 0o600 });
  }
  return (text, { diagnostic = false } = {}) => {
    try {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        if (suppressed) append(`[supervisor] output rate limited: ${suppressed} lines`);
        windowStart = now; count = 0; suppressed = 0;
      }
      if (!diagnostic && count++ >= 100) { suppressed++; return; }
      append(text);
    } catch { /* Disk failure cannot interrupt lifecycle detection or leak raw output. */ }
  };
}

// Streams are observers. Only child exit/error completes the run, never stdout EOF.
export function consumeWorkerStream(stream, log, label) {
  if (!stream) return () => {};
  const decoder = new StringDecoder("utf8");
  let pending = "", dropping = false, ended = false;
  const flush = () => { if (ended) return; ended = true; pending += decoder.end();
    if (pending && !dropping) log(pending); pending = ""; };
  stream.on("data", (chunk) => {
    if (ended) return;
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!dropping && line.length <= 16000) log(line.replace(/\r$/, ""));
      else log(`[supervisor] ${label} oversized line omitted`);
      dropping = false;
    }
    // Do not split an oversized secret into separately redactable fragments.
    if (pending.length > 16000) { pending = ""; dropping = true; }
  });
  stream.once("end", flush);
  stream.once("close", flush);
  stream.once("error", (error) => { log(`[supervisor] ${label} read error: ${error.code ?? "UNKNOWN"}`, { diagnostic: true }); flush(); stream.destroy(); });
  return () => { flush(); stream.destroy(); };
}

export async function superviseWorker({ command = process.execPath, args, cwd, env = process.env,
  runtimeDir, metricsPath, log, spawnChild = spawn, signals = process,
  pollMs = 5000, thresholdMs = heartbeatThreshold(env), drainMs = 250,
  identityReader = processIdentity }) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const pidPath = join(runtimeDir, "sync-worker.pid"), identityPath = join(runtimeDir, "sync-worker.identity.json");
  const statePath = join(runtimeDir, "sync-worker-runner.state");
  const state = (value) => fs.writeFileSync(statePath, `${value} ${new Date().toISOString()}\n`);
  // Never launch alongside a live recorded PID, even if the old identity is absent/mismatched.
  if (identityReader(Number(read(pidPath).trim()))) {
    state("DEGRADED"); log("[supervisor] existing live PID requires ownership review", { diagnostic: true });
    return 22;
  }
  for (const path of [pidPath, identityPath]) if (fs.existsSync(path)) fs.unlinkSync(path);
  state("STOPPED");
  state("STARTING");
  let child;
  try { child = spawnChild(command, args, { cwd: resolve(cwd), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
  catch (error) { state("STOPPED"); log(`[supervisor] spawn failure ${error.code ?? "UNKNOWN"}`, { diagnostic: true }); return 1; }
  return new Promise((resolveRun) => {
    let finished = false, interval, timer, expected, lastState;
    const stopOut = consumeWorkerStream(child.stdout, log, "stdout");
    let fatalRecorded = false;
    const stopErr = consumeWorkerStream(child.stderr, (line, options) => {
      // Reserve one fatal record even when ordinary child output is rate limited.
      if (!fatalRecorded && line.includes('"category":"worker-fatal"')) {
        fatalRecorded = true; log(line, { diagnostic: true });
      } else log(line, options);
    }, "stderr");
    const relay = (signal) => { if (!finished) child.kill(signal); };
    const sigterm = () => relay("SIGTERM"), sigint = () => relay("SIGINT");
    signals.on("SIGTERM", sigterm); signals.on("SIGINT", sigint);
    function finish(code, signal, category) {
      if (finished) return;
      finished = true; clearInterval(interval);
      state("STOPPED");
      for (const path of [pidPath, identityPath]) if (fs.existsSync(path)) fs.unlinkSync(path);
      log(`[supervisor] child ${category} code=${code ?? "null"} signal=${signal ?? "none"}`, { diagnostic: true });
      signals.removeListener("SIGTERM", sigterm); signals.removeListener("SIGINT", sigint);
      // A descendant may retain a pipe. Never wait forever for close after exit.
      let settled = false;
      const settle = () => { if (settled) return; settled = true; clearTimeout(timer); stopOut(); stopErr();
        resolveRun(signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1)); };
      child.once("close", settle);
      timer = setTimeout(settle, drainMs);
    }
    child.once("spawn", () => {
      expected = { ...identityReader(child.pid), pid: child.pid, startedAt: Date.now() };
      fs.writeFileSync(pidPath, `${child.pid}\n`);
      fs.writeFileSync(identityPath, JSON.stringify(expected), { mode: 0o600 });
      log(`[supervisor] worker spawned pid=${child.pid}`, { diagnostic: true });
      interval = setInterval(() => {
        const result = inspectWorker({ runtimeDir, metricsPath, thresholdMs, identityReader });
        if (result.state !== lastState) { lastState = result.state; state(result.state);
          log(`[supervisor] liveness=${result.state}`, { diagnostic: true }); }
        // Observation only: stale heartbeat never causes a kill/restart.
      }, pollMs);
    });
    child.once("error", (error) => { log(`[supervisor] child error ${error.code ?? "UNKNOWN"}`, { diagnostic: true });
      // Post-spawn errors (e.g. failed signal delivery) are not evidence of death.
      if (!child.pid) finish(1, null, "spawn-error"); });
    child.once("exit", (code, signal) => finish(code, signal, "exit"));
  });
}
