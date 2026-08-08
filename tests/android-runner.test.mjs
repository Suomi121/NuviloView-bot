import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(new URL("../Android/run-bot-forever.sh", import.meta.url), "utf8");
const setup = await readFile(new URL("../Android/setup-termux.sh", import.meta.url), "utf8");
const boot = await readFile(new URL("../Android/boot-start.sh", import.meta.url), "utf8");

test("Android runner uses the shared Bot and only the current Bot token name", () => {
  assert.match(runner, /discord-bot\.mjs/);
  assert.match(runner, /NUVILOVIEW_BOT_TOKEN/);
  assert.doesNotMatch(runner, /DISCORD_BOT_TOKEN/);
  assert.doesNotMatch(runner, /C:\\/);
  assert.doesNotMatch(runner, /\/usr\/bin\/node|\/data\/data\/com\.termux\/files\/usr\/bin\/node/);
});

test("Android runner exposes validation, once, status, stop, and bounded backoff", () => {
  for (const option of ["--validate-only", "--once", "--status", "--stop"]) assert.match(runner, new RegExp(option));
  assert.match(runner, /RESTART_DELAYS=\(5 15 30 60 120 300 600 900\)/);
  assert.match(runner, /STABLE_RUN_SECONDS=300/);
  assert.match(runner, /LOG_RETENTION_DAYS=14/);
});

test("Android runner includes lock, PID, signal, session-limit, and redaction controls", () => {
  for (const expected of ["runner.lock", "runner.pid", "bot.pid", "SIGINT", "SIGTERM", "Session Start Limit", "[REDACTED]"]) {
    assert.ok(runner.includes(expected), `missing ${expected}`);
  }
  assert.match(runner, /mkdir -- "\$LOCK_DIR"/);
  assert.match(runner, /kill -0/);
});

test("Termux setup uses pnpm lockfile and private project-relative paths", () => {
  assert.match(setup, /pnpm install --filter nuviloview-oem --frozen-lockfile/);
  assert.match(setup, /chmod 600 -- "\$ENV_FILE"/);
  assert.match(setup, /SCRIPT_DIR=/);
  assert.match(boot, /run-bot-forever\.sh/);
  assert.match(boot, /termux-wake-lock/);
  assert.doesNotMatch(`${setup}\n${boot}`, /C:\\/);
});
