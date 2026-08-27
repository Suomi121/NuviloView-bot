import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../components/message-history-import-panel.tsx", import.meta.url), "utf8");
const settings = await readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8");

test("Settings delegates import UX without changing its account and theme controls", () => {
  assert.match(settings, /<MessageHistoryImportPanel guilds=\{guilds\} locale=\{locale\} \/>/);
  assert.match(settings, /<ThemeCustomizer guilds=\{guilds\} \/>/);
  assert.match(settings, /signOut/);
});

test("UI can represent every v2 lifecycle state and empty loading states", () => {
  for (const status of ["queued", "preparing", "running", "pausing", "paused", "cancelling", "cancelled", "completed", "failed", "stalled"]) {
    assert.match(panel, new RegExp(`${status}:`));
  }
  assert.match(panel, /Loading import state/);
  assert.match(panel, /No import history/);
  assert.match(panel, /No channel checkpoints yet/);
});

test("UI exposes real progress, diagnostics, batch-safe controls, and channel actions", () => {
  for (const label of ["Fetched", "Inserted", "Duplicates", "Failed", "Current", "Discord API", "Database", "Import Worker"]) {
    assert.match(panel, new RegExp(label));
  }
  for (const action of ["pause", "resume", "cancel", "retry-channel", "skip-channel", "reset"]) {
    assert.match(panel, new RegExp(`mutate\\(\\"${action}\\"`));
  }
  assert.match(panel, /No message total is guessed/);
  assert.doesNotMatch(panel, /estimatedMessages\s*\?[^:]+100/);
});

test("UI separates state reset from exact-confirmation imported-data deletion", () => {
  assert.match(panel, /Reset import state/);
  assert.match(panel, /RESET IMPORTED DATA/);
  assert.match(panel, /method: "DELETE"/);
  assert.match(panel, /Live data is never selected/);
});

test("queued local deletion is not falsely reported as an immediate deletion", () => {
  assert.match(panel, /data\.deletionQueued/);
  assert.match(panel, /Botがローカルで安全に処理します/);
});

test("terminal jobs can start a new import while active jobs cannot", () => {
  assert.match(panel, /canStartNew = !job \|\| \["cancelled", "completed", "failed"\]\.includes\(job\.status\)/);
  assert.match(panel, /disabled=\{!guilds\.length \|\| importActive/);
});
