import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const android = join(root, "Android");
const names = [
  "runtime-common.sh",
  "termux-preflight.sh",
  "boot-start.sh",
  "run-bot-forever.sh",
  "run-sync-worker-forever.sh",
  "stop-nuviloview.sh",
  "status-nuviloview.sh",
  "install-termux-boot.sh",
];
const sources = Object.fromEntries(
  await Promise.all(names.map(async (name) => [name, await readFile(join(android, name), "utf8")])),
);
const canRunBash = process.platform !== "win32" &&
  spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;

test("Termux runtime has no boot-time auto update or Production mutation", () => {
  const runtimeSource = Object.values(sources).join("\n");
  for (const forbidden of [
    /git\s+(?:fetch|pull|reset)/,
    /pnpm\s+update/,
    /vercel\s+(?:deploy|--prod)/,
    /db:migrate.*--execute/,
  ]) {
    assert.doesNotMatch(runtimeSource, forbidden);
  }
});

test("Boot supervisor is short-lived and launches independent runners", () => {
  const boot = sources["boot-start.sh"];
  assert.match(boot, /termux-preflight\.sh/);
  assert.match(boot, /run-bot-forever\.sh/);
  assert.match(boot, /run-sync-worker-forever\.sh/);
  assert.match(boot, /boot\.lock/);
  assert.match(boot, /already active|duplicate start/);
  assert.doesNotMatch(boot, /while\s+true|while\s+:/);
});

test("Preflight defines PASS, WARN, FAIL and local safety gates", () => {
  const preflight = sources["termux-preflight.sh"];
  for (const expected of [
    "PASS",
    "WARN",
    "FAIL",
    "node_sqlite_unavailable",
    "message_local_first_requires_writable_local_storage",
    "history_import_requires_sqlite_first",
    "history_import_guild_not_message_canary",
    "history_import_guild_not_compaction_canary",
    "disk_free_critical",
    "network_route_unavailable",
    "neon=not_configured_bot_will_start_degraded",
  ]) assert.ok(preflight.includes(expected), `missing ${expected}`);
  assert.doesNotMatch(preflight, /pool\.query|SELECT\s+1/i);
});

test("Stop and status cover both processes without exposing env values", () => {
  assert.match(sources["stop-nuviloview.sh"], /run-bot-forever\.sh/);
  assert.match(sources["stop-nuviloview.sh"], /run-sync-worker-forever\.sh/);
  assert.match(sources["stop-nuviloview.sh"], /termux-wake-unlock/);
  assert.match(sources["status-nuviloview.sh"], /Circuit:/);
  assert.match(sources["status-nuviloview.sh"], /Pending:/);
  assert.match(sources["status-nuviloview.sh"], /Dead Letter:/);
  assert.match(sources["status-nuviloview.sh"], /Runtime Mode:/);
  assert.match(sources["status-nuviloview.sh"], /Neon:/);
  assert.match(sources["status-nuviloview.sh"], /Cross-Host Leadership:/);
  assert.match(sources["status-nuviloview.sh"], /Message History Import:/);
  assert.match(sources["status-nuviloview.sh"], /state_suffix/);
  assert.doesNotMatch(sources["status-nuviloview.sh"], /PID %s%s[^\n]*\$pid[^\n]*\$state"/);
  assert.doesNotMatch(sources["status-nuviloview.sh"], /printf[^\n]*(DATABASE_URL|BOT_TOKEN)/);
});

test("Bot runner closes the coprocess output pipe during shutdown", () => {
  const runner = sources["run-bot-forever.sh"];
  assert.match(runner, /CURRENT_BOT_OUTPUT_FD="\$bot_output_fd"/);
  assert.match(runner, /exec \{CURRENT_BOT_OUTPUT_FD\}<\&-/);
  assert.match(runner, /raw_line=""/);
});

test("Termux:Boot installer creates an idempotent thin wrapper", { skip: !canRunBash }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nuviloview-boot-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bootDir = join(directory, "boot");
  const env = {
    ...process.env,
    NUVILOVIEW_ALLOW_NON_TERMUX_TEST: "1",
    NUVILOVIEW_PROJECT_ROOT: root,
    TERMUX_BOOT_DIR: bootDir,
  };
  await chmod(join(android, "boot-start.sh"), 0o700);
  const installer = join(android, "install-termux-boot.sh");
  const first = spawnSync("bash", [installer], { env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const wrapper = join(bootDir, "nuviloview.sh");
  const firstText = await readFile(wrapper, "utf8");
  const second = spawnSync("bash", [installer], { env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(wrapper, "utf8"), firstText);
  assert.match(firstText, /Android\/boot-start\.sh/);
  assert.doesNotMatch(firstText, /TOKEN|DATABASE_URL|git pull/);
});

test("Preflight warns for optional host gaps and fails flag contradictions", { skip: !canRunBash }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nuviloview-preflight-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, "runtime");
  const logs = join(directory, "logs");
  const fakeBin = join(directory, "bin");
  const bootDir = join(directory, "boot");
  const envFile = join(directory, ".env.local");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(bootDir, { recursive: true });
  const fakePnpm = join(fakeBin, "pnpm");
  await writeFile(fakePnpm, "#!/usr/bin/env bash\nprintf '11.22.0\\n'\n", { mode: 0o700 });
  await writeFile(join(fakeBin, "termux-wake-lock"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await writeFile(join(fakeBin, "ip"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await writeFile(join(bootDir, "nuviloview.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await writeFile(envFile, [
    "NUVILOVIEW_BOT_TOKEN=test-only-placeholder",
    "NUVILOVIEW_CLIENT_ID=123456789012345678",
    "LOCAL_STORAGE_ENABLED=false",
    "LOCAL_STORAGE_WRITE_ENABLED=false",
    "LOCAL_MESSAGE_STORAGE_ENABLED=false",
    "SYNC_WORKER_ENABLED=false",
  ].join("\n"), { mode: 0o600 });
  const baseEnv = {
    ...process.env,
    NUVILOVIEW_ALLOW_NON_TERMUX_TEST: "1",
    NUVILOVIEW_PROJECT_ROOT: root,
    NUVILOVIEW_ENV_FILE: envFile,
    NUVILOVIEW_ANDROID_RUNTIME_DIR: runtime,
    NUVILOVIEW_ANDROID_LOG_DIR: logs,
    TERMUX_BOOT_DIR: bootDir,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const warn = spawnSync("bash", [join(android, "termux-preflight.sh")], {
    env: baseEnv,
    encoding: "utf8",
  });
  assert.equal(warn.status, 0, `${warn.stderr}\n${warn.stdout}`);
  assert.match(warn.stdout, /Preflight: WARN/);
  assert.match(warn.stdout, /WARN neon=not_configured_bot_will_start_degraded/);

  await writeFile(envFile, [
    "LOCAL_STORAGE_ENABLED=false",
    "LOCAL_STORAGE_WRITE_ENABLED=false",
    "LOCAL_MESSAGE_STORAGE_ENABLED=true",
    "SYNC_WORKER_ENABLED=false",
  ].join("\n"), { mode: 0o600 });
  const fail = spawnSync("bash", [join(android, "termux-preflight.sh")], {
    env: baseEnv,
    encoding: "utf8",
  });
  assert.notEqual(fail.status, 0);
  assert.match(fail.stdout, /FAIL message_local_first_requires_writable_local_storage/);
});

test("Worker disabled is successful and a fake crash enters cooldown", { skip: !canRunBash }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nuviloview-worker-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const runtime = join(directory, "runtime");
  const logs = join(directory, "logs");
  const envFile = join(project, ".env.local");
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "node_modules", "pg"), { recursive: true });
  await writeFile(join(project, "package.json"), "{}\n");
  await writeFile(join(project, "node_modules", "pg", "package.json"), "{}\n");
  await writeFile(join(project, "scripts", "run-sync-worker.mjs"), "process.exit(1);\n");
  await writeFile(envFile, "SYNC_WORKER_ENABLED=false\n", { mode: 0o600 });
  const runner = join(android, "run-sync-worker-forever.sh");
  const baseEnv = {
    ...process.env,
    NUVILOVIEW_ALLOW_NON_TERMUX_TEST: "1",
    NUVILOVIEW_PROJECT_ROOT: project,
    NUVILOVIEW_ENV_FILE: envFile,
    NUVILOVIEW_ANDROID_RUNTIME_DIR: runtime,
    NUVILOVIEW_ANDROID_LOG_DIR: logs,
  };
  const disabled = spawnSync("bash", [runner, "--status"], { env: baseEnv, encoding: "utf8" });
  assert.equal(disabled.status, 0);
  assert.match(disabled.stdout, /DISABLED/);

  await writeFile(envFile, [
    "SYNC_WORKER_ENABLED=true",
    "SYNC_NEON_REPLICA_ENABLED=true",
    "LOCAL_STORAGE_ENABLED=true",
    "LOCAL_STORAGE_WRITE_ENABLED=true",
    "DATABASE_URL=postgresql://local-test.invalid/db",
    "SYNC_RUNNER_CRASH_LIMIT=2",
    "SYNC_RUNNER_CRASH_WINDOW_SECONDS=60",
    "SYNC_RUNNER_CRASH_COOLDOWN_SECONDS=10",
  ].join("\n"), { mode: 0o600 });
  const child = spawn("bash", [runner], { env: baseEnv, stdio: "ignore" });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  const state = await readFile(join(runtime, "sync-worker-runner.state"), "utf8");
  assert.match(state, /COOLDOWN|DEGRADED/);
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
});

test("Boot-equivalent start is idempotent and the Bot stops gracefully", { skip: !canRunBash }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nuviloview-boot-runtime-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const runtime = join(directory, "runtime");
  const logs = join(directory, "logs");
  const fakeBin = join(directory, "bin");
  const envFile = join(project, ".env.local");
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "node_modules", "discord.js"), { recursive: true });
  await mkdir(join(project, "node_modules", "@neondatabase", "serverless"), { recursive: true });
  await mkdir(join(project, "node_modules", "pg"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ packageManager: "pnpm@11.22.0" }));
  await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const packagePath of [
    join(project, "node_modules", "discord.js", "package.json"),
    join(project, "node_modules", "@neondatabase", "serverless", "package.json"),
    join(project, "node_modules", "pg", "package.json"),
  ]) await writeFile(packagePath, "{}\n");
  await writeFile(
    join(project, "discord-bot.mjs"),
    'import { existsSync, writeFileSync } from "node:fs";\nif (!existsSync(process.env.BOT_TEST_MARKER)) { writeFileSync(process.env.BOT_TEST_MARKER, "crashed-once"); process.exit(1); }\nconsole.log("bot logged in as integration-test");\nprocess.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1000);\n',
  );
  await writeFile(join(project, "scripts", "token-leak-check.mjs"), 'console.log("token check passed");\n');
  await writeFile(join(project, "scripts", "run-sync-worker.mjs"), "process.exit(0);\n");
  const fakePnpm = join(fakeBin, "pnpm");
  await writeFile(fakePnpm, "#!/usr/bin/env bash\nprintf '11.22.0\\n'\n", { mode: 0o700 });
  await writeFile(envFile, [
    "DATABASE_URL=postgresql://test-user:test-password@invalid.local/test",
    "NUVILOVIEW_CLIENT_ID=123456789012345678",
    "NUVILOVIEW_BOT_TOKEN=integration-test-token",
    "LOCAL_STORAGE_ENABLED=false",
    "LOCAL_STORAGE_WRITE_ENABLED=false",
    "LOCAL_MESSAGE_STORAGE_ENABLED=false",
    "SYNC_WORKER_ENABLED=false",
    `BOT_TEST_MARKER=${join(directory, "bot-crashed-once")}`,
    "ANDROID_BOOT_INITIAL_DELAY_SECONDS=0",
    "ANDROID_BOOT_PREFLIGHT_ATTEMPTS=1",
  ].join("\n"), { mode: 0o600 });
  const env = {
    ...process.env,
    NUVILOVIEW_ALLOW_NON_TERMUX_TEST: "1",
    NUVILOVIEW_PROJECT_ROOT: project,
    NUVILOVIEW_ENV_FILE: envFile,
    NUVILOVIEW_ANDROID_RUNTIME_DIR: runtime,
    NUVILOVIEW_ANDROID_LOG_DIR: logs,
    TERMUX_BOOT_DIR: join(directory, "missing-boot"),
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const boot = join(android, "boot-start.sh");
  const stop = join(android, "stop-nuviloview.sh");
  t.after(() => spawnSync("bash", [stop], { env, encoding: "utf8" }));

  const first = spawnSync("bash", [boot], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const firstPid = await readFile(join(runtime, "runner.pid"), "utf8");
  const second = spawnSync("bash", [boot], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
  assert.equal(await readFile(join(runtime, "runner.pid"), "utf8"), firstPid);

  const status = spawnSync("bash", [join(android, "status-nuviloview.sh")], {
    env,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Bot Runner: RUNNING/);
  assert.match(status.stdout, /Sync Worker: DISABLED/);

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_500));
  const recoveredStatus = spawnSync("bash", [join(android, "status-nuviloview.sh")], {
    env,
    encoding: "utf8",
  });
  assert.match(recoveredStatus.stdout, /Bot: RUNNING/);

  const stopped = spawnSync("bash", [stop], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  const stoppedStatus = spawnSync("bash", [join(android, "status-nuviloview.sh")], {
    env,
    encoding: "utf8",
  });
  assert.match(stoppedStatus.stdout, /Bot Runner: STOPPED/);
});

test("Runtime redaction masks known secrets and PostgreSQL passwords", { skip: !canRunBash }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nuviloview-redaction-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, [
    "NUVILOVIEW_BOT_TOKEN=a-very-secret-test-token",
    "DATABASE_URL=postgresql://test-user:another-secret-password@db.invalid/test",
  ].join("\n"), { mode: 0o600 });
  const command = [
    `source '${join(android, "runtime-common.sh")}'`,
    `nv_load_redaction_secrets '${envFile}'`,
    "nv_redact_line 'a-very-secret-test-token postgresql://test-user:another-secret-password@db.invalid/test'",
  ].join("; ");
  const result = spawnSync("bash", ["-lc", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /a-very-secret-test-token|another-secret-password/);
  assert.match(result.stdout, /\[REDACTED\]/);
});
