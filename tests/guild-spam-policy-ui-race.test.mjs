import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGuildSpamPolicyRequestGuard } from "../lib/guild-spam-policy-request-guard.mjs";

const guildA = "11111111111111111";
const guildB = "22222222222222222";
const panelSource = readFileSync(new URL("../components/guild-spam-policy-panel.tsx", import.meta.url), "utf8");

function applyIfCurrent(request, value, applied) {
  if (!request.isCurrent()) return false;
  applied.push(value);
  return true;
}

test("Guild A policy GET is ignored when the user switches to Guild B", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const request = guard.begin("load", guildA);
  guard.selectGuild(guildB);
  const applied = [];
  assert.equal(applyIfCurrent(request, "Guild A policy", applied), false);
  assert.deepEqual(applied, []);
});

test("Guild A Save response cannot replace Guild B state after a switch", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const request = guard.begin("mutation", guildA);
  guard.selectGuild(guildB);
  const applied = [];
  assert.equal(applyIfCurrent(request, "Guild A saved policy", applied), false);
  assert.deepEqual(applied, []);
});

test("Guild A Reset response cannot replace Guild B state after a switch", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const request = guard.begin("mutation", guildA);
  guard.selectGuild(guildB);
  const applied = [];
  assert.equal(applyIfCurrent(request, "Guild A default policy", applied), false);
  assert.deepEqual(applied, []);
});

test("an older Save response is ignored when a newer mutation finishes first", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const first = guard.begin("mutation", guildA);
  const second = guard.begin("mutation", guildA);
  const applied = [];
  assert.equal(applyIfCurrent(second, "newer policy", applied), true);
  assert.equal(applyIfCurrent(first, "older policy", applied), false);
  assert.deepEqual(applied, ["newer policy"]);
});

test("a stale Guild A failure is not allowed to publish an error in Guild B", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const request = guard.begin("mutation", guildA);
  guard.selectGuild(guildB);
  const errors = [];
  if (request.isCurrent()) errors.push("Guild A failed");
  assert.deepEqual(errors, []);
});

test("the stale-response guard still works when an aborted request resolves anyway", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const request = guard.begin("load", guildA);
  // Deliberately do not simulate AbortController taking effect.
  guard.selectGuild(guildB);
  const applied = [];
  assert.equal(applyIfCurrent(request, "late response", applied), false);
  assert.deepEqual(applied, []);
});

test("panel wires generation checks, Guild-change cancellation, and mutation target capture", () => {
  assert.match(panelSource, /createGuildSpamPolicyRequestGuard\(\)/);
  assert.match(panelSource, /begin\("load", targetGuildId\)/);
  assert.match(panelSource, /begin\("mutation", targetGuildId\)/);
  assert.ok((panelSource.match(/request\.isCurrent\(\)/g) ?? []).length >= 6);
  assert.match(panelSource, /policyLoadAbortRef\.current\?\.abort\(\)/);
  assert.match(panelSource, /mutationAbortRef\.current\?\.abort\(\)/);
  assert.match(panelSource, /signal: controller\.signal/);
  assert.match(panelSource, /onChange=\{\(event\) => selectGuild\(event\.target\.value\)\}/);
});

test("unmount invalidates outstanding requests before late responses can apply", () => {
  const guard = createGuildSpamPolicyRequestGuard();
  guard.selectGuild(guildA);
  const request = guard.begin("mutation", guildA);
  guard.unmount();
  assert.equal(request.isCurrent(), false);
});
