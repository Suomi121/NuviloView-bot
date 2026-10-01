import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { consumeWorkerStream, createBoundedWorkerLog, evaluateWorkerState, heartbeatThreshold, inspectWorker, superviseWorker } from "../lib/sync/worker-supervisor.mjs";
import { createWorkerRedactor, installWorkerCrashDiagnostics } from "../lib/sync/worker-diagnostics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const preload = new URL("../scripts/worker-crash-preload.mjs", import.meta.url).href;
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "worker-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines = [], states = [];
  return { dir, lines, states, options: { cwd: dir, runtimeDir: dir, metricsPath: join(dir, "health.json"),
    signals: new EventEmitter(), pollMs: 20, drainMs: 50,
    log: (line) => { lines.push(line); if (fs.existsSync(join(dir, "sync-worker-runner.state"))) states.push(fs.readFileSync(join(dir, "sync-worker-runner.state"), "utf8").split(" ")[0]); } } };
}
function stopped(f) {
  assert.match(fs.readFileSync(join(f.dir, "sync-worker-runner.state"), "utf8"), /^STOPPED /);
  assert.equal(fs.existsSync(join(f.dir, "sync-worker.pid")), false);
  assert.equal(fs.existsSync(join(f.dir, "sync-worker.identity.json")), false);
  assert.equal(f.lines.filter(x => /child (exit|spawn-error)/.test(x)).length, 1);
}

test("old invalid-FD raw_line bug reproduces with a finite five-iteration cap", () => {
  const result = spawnSync(bash, ["-c", 'raw_line=last; n=0; while IFS= read -r -u 999 raw_line 2>/dev/null || [[ -n "${raw_line:-}" ]]; do n=$((n+1)); if ((n==5)); then break; fi; done; printf "%s:%s" "$n" "$raw_line"'], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "5:last");
});
test("normal stdout/stderr and unterminated final line are each consumed once; clean exit stops", async t => {
  const f = await fixture(t);
  const code = await superviseWorker({ ...f.options, args: ["-e", "console.log('OUT'); console.error('ERR'); process.stdout.write('LAST');"] });
  assert.equal(code, 0); for (const line of ["OUT", "ERR", "LAST"]) assert.equal(f.lines.filter(x => x === line).length, 1);
  stopped(f);
});
test("non-zero child exit returns its status to restart policy", async t => {
  const f = await fixture(t); assert.equal(await superviseWorker({ ...f.options, args: ["-e", "process.exitCode=7;"] }), 7); stopped(f);
});
test("spawn failure error + close handled once without stale PID", async t => {
  const f = await fixture(t); assert.equal(await superviseWorker({ ...f.options, command: join(f.dir, "does-not-exist"), args: [] }), 1); stopped(f);
});
test("unhandled emitter error records redacted diagnostics and still kills dummy child", async t => {
  const f = await fixture(t); const output = join(f.dir, "output.log");
  const env = { ...process.env, TEST_SECRET: "fixture-sensitive-value", DATABASE_URL: "postgresql://dummy:fixture-password@invalid.test/db" };
  const logger = createBoundedWorkerLog({ path: output, env });
  const code = await superviseWorker({ ...f.options, env, log: (line, opts) => { f.options.log(line); logger(line, opts); }, args: ["--import", preload, "-e", "const {EventEmitter}=require('node:events'); setImmediate(()=>new EventEmitter().emit('error',Object.assign(new Error(process.env.TEST_SECRET+' '+process.env.DATABASE_URL),{code:'E_DUMMY'})));"] });
  assert.notEqual(code, 0); stopped(f);
  const logs = fs.readFileSync(output, "utf8");
  assert.match(logs, /worker-fatal/); assert.match(logs, /E_DUMMY/); assert.match(logs, /uncaughtException/);
  assert.doesNotMatch(logs, /fixture-sensitive-value|fixture-password|postgresql:\/\//);
});
test("unhandled rejection uses fatal semantics and records origin", async t => {
  const f = await fixture(t);
  assert.notEqual(await superviseWorker({ ...f.options, args: ["--import", preload, "-e", "Promise.reject(new Error('dummy-rejection'));setTimeout(()=>{},30);"] }), 0);
  assert.ok(f.lines.some(x => x.includes('"origin":"unhandledRejection"'))); stopped(f);
});
for (const fd of [1, 2]) test(`fd ${fd} closes before child exit; lifecycle remains supervised`, async t => {
  const f = await fixture(t); const began = Date.now();
  assert.equal(await superviseWorker({ ...f.options, args: ["-e", `require('node:fs').closeSync(${fd});setTimeout(()=>process.exit(4),120);`] }), 4);
  assert.ok(Date.now() - began >= 100); stopped(f);
});
test("invalid reader FD/error + duplicate close does not block exit or repeat last line", async t => {
  const f = await fixture(t); const child = new EventEmitter(); child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const run = superviseWorker({ ...f.options, args: [], spawnChild: () => child, identityReader: pid => pid === 123 ? { pid: 123, start: "1" } : null });
  child.emit("spawn"); child.stdout.write("last"); child.stdout.emit("error", Object.assign(new Error("private"), { code: "EBADF" }));
  child.emit("exit", 3, null); child.emit("close", 3, null); child.emit("close", 3, null);
  assert.equal(await run, 3); assert.equal(f.lines.filter(x => x === "last").length, 1); stopped(f);
  assert.ok(f.lines.some(x => /read error: EBADF/.test(x))); assert.ok(!f.lines.some(x => x.includes("private")));
});
test("descendant-held stream never blocks completion after child exit", async t => {
  const f = await fixture(t); const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const run = superviseWorker({ ...f.options, args: [], spawnChild: () => child, identityReader: pid => pid === 123 ? { pid, start: "1" } : null });
  child.emit("spawn"); child.emit("exit", 0, null);
  assert.equal(await run, 0); stopped(f);
});
test("signal termination recorded once with code mapping", async t => {
  const f = await fixture(t); const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.emit("exit", null, signal); child.emit("close", null, signal); };
  const run = superviseWorker({ ...f.options, args: [], spawnChild: () => child, identityReader: pid => pid === 123 ? { pid, start: "1" } : null });
  child.emit("spawn"); f.options.signals.emit("SIGTERM"); assert.equal(await run, 143); stopped(f);
  assert.ok(f.lines.some(x => /signal=SIGTERM/.test(x)));
});
test("stale PID and saved RUNNING are corrected before a new spawn", async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, "sync-worker.pid"), "99999999\n");
  fs.writeFileSync(join(f.dir, "sync-worker-runner.state"), "RUNNING old\n");
  assert.equal(inspectWorker({ runtimeDir: f.dir, metricsPath: join(f.dir, "health.json"), thresholdMs: 120000 }).state, "STOPPED");
  assert.equal(await superviseWorker({ ...f.options, args: ["-e", "process.exit(0)"] }), 0); stopped(f);
});
test("live recorded PID refuses a second worker and does not delete identity", async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, "sync-worker.pid"), String(process.pid));
  const code = await superviseWorker({ ...f.options, args: [], spawnChild: () => { throw new Error("must not spawn"); } });
  assert.equal(code, 22); assert.equal(fs.readFileSync(join(f.dir, "sync-worker.pid"), "utf8"), String(process.pid));
});
test("PID reuse, missing identity, future/stale heartbeat never mean RUNNING", () => {
  const base = { identity: { pid: 12, start: "new" }, expected: { pid: 12, start: "new" }, heartbeatAt: 4900, startedAt: 1000, now: 5000, thresholdMs: 200 };
  assert.equal(evaluateWorkerState(base), "RUNNING");
  assert.equal(evaluateWorkerState({ ...base, identity: null }), "STOPPED");
  assert.equal(evaluateWorkerState({ ...base, expected: null }), "DEGRADED");
  assert.equal(evaluateWorkerState({ ...base, expected: { pid: 12, start: "old" } }), "DEGRADED");
  for (const heartbeatAt of [0, 4700, 50000, NaN]) assert.equal(evaluateWorkerState({ ...base, heartbeatAt }), "DEGRADED");
  assert.equal(heartbeatThreshold({}), 120000); assert.equal(heartbeatThreshold({ SYNC_METRICS_INTERVAL_MS: "60000" }), 240000);
});
test("live hung child becomes DEGRADED without automatic kill", async t => {
  const f = await fixture(t); const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0; child.kill = () => { kills++; };
  const run = superviseWorker({ ...f.options, thresholdMs: 25, pollMs: 10, args: [], spawnChild: () => child, identityReader: pid => pid === 123 ? { pid, start: "1" } : null });
  child.emit("spawn"); await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(fs.readFileSync(join(f.dir, "sync-worker-runner.state"), "utf8"), /^DEGRADED /); assert.equal(kills, 0);
  child.emit("exit", 0, null); child.emit("close", 0, null); await run;
});
test("log rotation and line rate bound hold during a single long run", async t => {
  const f = await fixture(t); const path = join(f.dir, "output.log"), log = createBoundedWorkerLog({ path, maxBytes: 1024 });
  for (let i = 0; i < 2000; i++) log(`line-${i} ${"x".repeat(200)}`);
  const files = fs.readdirSync(f.dir).filter(x => x.startsWith("output.log"));
  assert.ok(files.length <= 4); for (const file of files) assert.ok(fs.statSync(join(f.dir, file)).size <= 1024);
  const data = files.map(x => fs.readFileSync(join(f.dir, x), "utf8")).join(""); assert.doesNotMatch(data, /line-1999/);
});
test("redaction is robust across split chunks; oversized lines omitted without leaking fragments", () => {
  const lines = [], redact = createWorkerRedactor({ TEST_TOKEN: "split-sensitive-value" }); const s = new PassThrough();
  const finish = consumeWorkerStream(s, line => lines.push(redact(line)), "stderr");
  s.write("split-sensitive-"); s.write("value\n"); s.write("a".repeat(20000)); s.write("sensitive-tail\n"); finish();
  assert.doesNotMatch(lines.join("\n"), /split-sensitive|sensitive-tail/); assert.match(lines.join("\n"), /REDACTED/);
});
test("monitor records but never installs an uncaughtException recovery handler", () => {
  const target = new EventEmitter(), lines = [];
  const remove = installWorkerCrashDiagnostics({ target, env: { TEST_TOKEN: "secret-test-only" }, write: x => lines.push(x) });
  installWorkerCrashDiagnostics({ target }); assert.equal(target.listenerCount("uncaughtExceptionMonitor"), 1);
  assert.equal(target.listenerCount("uncaughtException"), 0);
  target.emit("uncaughtExceptionMonitor", new Error("secret-test-only"), "uncaughtException");
  assert.doesNotMatch(lines[0], /secret-test-only/); remove();
});
test("shell delegates lifecycle and preserves bounded backoff/cooldown", () => {
  const source = fs.readFileSync(join(root, "Android/run-sync-worker-forever.sh"), "utf8");
  assert.doesNotMatch(source, /coproc|read -r -u|raw_line/);
  assert.match(source, /supervise-sync-worker\.mjs/); assert.match(source, /RESTART_DELAYS=\(1 2 5 10 30 60\)/);
  assert.match(source, /COOLDOWN/); assert.match(source, /worker_exit_code == 22/);
  assert.equal(spawnSync(bash, ["-n", join(root, "Android/run-sync-worker-forever.sh")]).status, 0);
});

test("executable crash policy escalates delays and enters cooldown without real sleeping", async t => {
  const f = await fixture(t);
  const source = fs.readFileSync(join(root, "Android/run-sync-worker-forever.sh"), "utf8");
  const functions = source.slice(source.indexOf("restart_delay() {"), source.indexOf("run_worker_once() {"));
  const policy = source.slice(source.indexOf("quick_failures=0\nrestart_count=0"), source.lastIndexOf('nv_write_state "$STATE_FILE" "STOPPED"'));
  const harness = `set -uo pipefail
RESTART_DELAYS=(1 2 5 10 30 60)
SHUTDOWN_REQUESTED=0; MODE=forever; ENV_FILE=unused; STATE_FILE=unused; NETWORK_FAILURE_SEEN=0
CRASH_HISTORY_FILE="$1/history"
${functions}
rotate_logs() { :; }
validate_configuration() { return 0; }
nv_load_redaction_secrets() { :; }
run_worker_once() { node -e 'process.exit(7)'; }
log() { :; }
nv_write_state() { printf 'STATE:%s\\n' "$2"; }
nv_positive_integer() { printf '%s' "$3"; }
sleep_interruptibly() { printf 'DELAY:%s\\n' "$1"; if (( $1 == 900 )); then SHUTDOWN_REQUESTED=1; fi; }
${policy}
for n in 6 7 20; do printf 'CAP:%s\\n' "$(restart_delay "$n")"; done
`;
  const result = spawnSync(bash, ["-c", harness, "test", f.dir.replaceAll("\\", "/")], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...result.stdout.matchAll(/DELAY:(\d+)/g)].map(x => Number(x[1])), [1, 2, 5, 10, 900]);
  assert.match(result.stdout, /STATE:COOLDOWN/);
  assert.deepEqual([...result.stdout.matchAll(/CAP:(\d+)/g)].map(x => Number(x[1])), [60, 60, 60]);
});

test("actual shell launcher runs an isolated dummy once and consumes its final output once", async t => {
  const f = await fixture(t);
  for (const dir of ["scripts", "node_modules/pg", "runtime", "logs", "bin"]) fs.mkdirSync(join(f.dir, dir), { recursive: true });
  // Native Windows node -p emits CRLF; emulate Termux's LF only for the version probe.
  if (process.platform === "win32") fs.writeFileSync(join(f.dir, "bin/node"), `#!/usr/bin/env bash\nif [[ "$1" == "-p" ]]; then "${process.execPath.replaceAll("\\", "/")}" "$@" | tr -d '\\r'; else exec "${process.execPath.replaceAll("\\", "/")}" "$@"; fi\n`);
  fs.writeFileSync(join(f.dir, "scripts/run-sync-worker.mjs"), "console.log('ONCE'); console.error('FINAL'); process.exitCode=7;");
  for (const path of ["package.json", "node_modules/pg/package.json"]) fs.writeFileSync(join(f.dir, path), "{}");
  fs.writeFileSync(join(f.dir, ".env.local"), "SYNC_WORKER_ENABLED=true\nLOCAL_STORAGE_ENABLED=true\nLOCAL_STORAGE_WRITE_ENABLED=true\nMULTI_DB_SYNC_ENABLED=true\n");
  const launch = () => spawnSync(bash, [join(root, "Android/run-sync-worker-forever.sh"), "--once"], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, PATH: `${join(f.dir, "bin")}${delimiter}${process.env.PATH}`, NUVILOVIEW_ALLOW_NON_TERMUX_TEST: "1",
      NUVILOVIEW_PROJECT_ROOT: f.dir.replaceAll("\\", "/"), NUVILOVIEW_ENV_FILE: join(f.dir, ".env.local").replaceAll("\\", "/"),
      NUVILOVIEW_ANDROID_RUNTIME_DIR: join(f.dir, "runtime").replaceAll("\\", "/"), NUVILOVIEW_ANDROID_LOG_DIR: join(f.dir, "logs").replaceAll("\\", "/") } });
  const result = launch();
  assert.equal(result.status, 7, result.stderr + fs.readFileSync(join(f.dir, "logs/sync-worker-runner.log"), "utf8"));
  const output = fs.readFileSync(join(f.dir, "logs/sync-worker-output.log"), "utf8");
  assert.equal((output.match(/ ONCE\n/g) ?? []).length, 1);
  assert.equal((output.match(/ FINAL\n/g) ?? []).length, 1);
  assert.equal(fs.existsSync(join(f.dir, "runtime/sync-worker.pid")), false);
  assert.match(fs.readFileSync(join(f.dir, "runtime/sync-worker-runner.state"), "utf8"), /^STOPPED /);
  fs.writeFileSync(join(f.dir, "runtime/sync-worker.pid"), String(process.pid));
  assert.equal(launch().status, 22);
  assert.equal(fs.readFileSync(join(f.dir, "runtime/sync-worker.pid"), "utf8"), String(process.pid));
  assert.match(fs.readFileSync(join(f.dir, "runtime/sync-worker-runner.state"), "utf8"), /^DEGRADED /);
});

test("oversized multibyte log entries cannot exceed the configured rotation bound", async t => {
  const f = await fixture(t), path = join(f.dir, "bounded.log");
  createBoundedWorkerLog({ path, maxBytes: 1024 })("語".repeat(15000));
  assert.ok(fs.statSync(path).size <= 1024);
});

test("fatal diagnostic survives ordinary-output rate limiting", async t => {
  const f = await fixture(t), path = join(f.dir, "crash.log");
  const code = await superviseWorker({ ...f.options, log: createBoundedWorkerLog({ path }),
    args: ["--import", preload, "-e", "for(let i=0;i<200;i++) console.error('noise'); setImmediate(()=>{throw Object.assign(new Error('dummy fatal'),{code:'TEST_FATAL'});});"] });
  assert.notEqual(code, 0);
  const data = fs.readFileSync(path, "utf8");
  assert.match(data, /worker-fatal/); assert.match(data, /TEST_FATAL/);
});
