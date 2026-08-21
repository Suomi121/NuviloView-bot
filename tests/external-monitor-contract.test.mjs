import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/monitor/bot/route.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/production-monitor.yml", import.meta.url), "utf8");

test("external monitor accepts a Bearer token without removing query-token compatibility", () => {
  assert.match(route, /request\.headers\.get\(['"]authorization['"]\)/);
  assert.match(route, /Bearer\\s\+/);
  assert.match(route, /searchParams\.get\(['"]token['"]\)/);
  assert.match(route, /timingSafeEqual/);
});

test("scheduled production monitoring is bounded and never places its token in the URL", () => {
  assert.match(workflow, /cron:\s*["']\*\/5 \* \* \* \*["']/);
  assert.match(workflow, /timeout-minutes:\s*2/);
  assert.match(workflow, /secrets\.NUVILOVIEW_BOT_MONITOR_TOKEN/);
  assert.match(workflow, /Authorization: Bearer \$\{MONITOR_TOKEN\}/);
  assert.doesNotMatch(workflow, /[?&]token=/);
  assert.doesNotMatch(workflow, /echo[^\n]*MONITOR_TOKEN/);
});
