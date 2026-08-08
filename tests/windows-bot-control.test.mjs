import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(new URL("../scripts/run-bot-forever.ps1", import.meta.url), "utf8");
const controller = await readFile(new URL("../scripts/bot-control.ps1", import.meta.url), "utf8");
const ui = await readFile(new URL("../scripts/bot-control-ui.ps1", import.meta.url), "utf8");
const launcher = await readFile(new URL("../NuviloView-Bot-Control.cmd", import.meta.url), "utf8");
const bot = await readFile(new URL("../discord-bot.mjs", import.meta.url), "utf8");

test("Windows controller exposes only bounded local Bot lifecycle actions", () => {
  assert.match(controller, /ValidateSet\('Status', 'Start', 'Stop', 'Restart'\)/);
  assert.match(controller, /run-bot-forever\.ps1/);
  assert.match(controller, /bot-runner\.pid/);
  assert.match(controller, /bot-runner\.stop/);
  assert.match(controller, /bot-disabled\.flag/);
  assert.match(controller, /startupEnabled/);
  assert.match(controller, /WindowStyle Hidden/);
  assert.match(controller, /Test-IsRunnerProcess/);
  assert.match(controller, /Get-DescendantProcessIds/);
  assert.doesNotMatch(controller, /NUVILOVIEW_BOT_TOKEN|DATABASE_URL|\.env\.local/);
});

test("Windows UI is a token-free on, off, restart, status, and log surface", () => {
  for (const label of ["オン", "オフ", "再起動", "状態を更新", "ログを開く"]) {
    assert.ok(ui.includes(label), `missing UI label: ${label}`);
  }
  assert.match(ui, /bot-control\.ps1/);
  assert.match(ui, /Timer/);
  assert.doesNotMatch(ui, /NUVILOVIEW_BOT_TOKEN|DATABASE_URL|\.env\.local/);
  assert.match(launcher, /bot-control-ui\.ps1/);
  assert.match(launcher, /WindowStyle Hidden/);
});

test("Windows runner and Bot cooperate on graceful local stop requests", () => {
  assert.match(runner, /NUVILOVIEW_BOT_STOP_FILE/);
  assert.match(runner, /Test-StopRequested/);
  assert.match(runner, /Wait-ForStopRequest/);
  assert.match(runner, /bot-runner\.pid/);
  assert.match(runner, /bot-runner\.stop/);
  assert.match(runner, /bot-disabled\.flag/);
  assert.match(runner, /persistent PC control setting/);
  assert.match(bot, /NUVILOVIEW_BOT_STOP_FILE/);
  assert.match(bot, /LOCAL_STOP_REQUEST/);
  assert.match(bot, /existsSync\(localStopFile\)/);
});
