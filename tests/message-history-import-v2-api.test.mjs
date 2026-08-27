import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/history-import/route.ts", import.meta.url), "utf8");

test("every import mutation uses session, Guild authorization, trusted origin, JSON size, and rate limiting", () => {
  assert.match(route, /auth\.api\.getSession/);
  assert.match(route, /mayManageGuild\(session\.user\.id, guildId\)/);
  assert.match(route, /isTrustedMutation\(request\)/);
  assert.match(route, /hasJsonBody\(request,/);
  assert.match(route, /isRateLimited\(request,/);
  assert.match(route, /WHERE "id" = \$1 AND "guildId" = \$2\s+FOR UPDATE/);
});

test("duplicate active imports rely on the per-Guild unique index and return conflict", () => {
  assert.match(route, /"version", "source", "status"/);
  assert.match(route, /code\?: string \}\)\.code === "23505"/);
  assert.match(route, /already has an active message import/);
});

test("state reset removes checkpoints but does not delete Analytics messages", () => {
  const resetStart = route.indexOf('if (input.action === "reset")');
  const channelStart = route.indexOf("const channelResult", resetStart);
  const resetBlock = route.slice(resetStart, channelStart);
  assert.match(resetBlock, /activeWorkerStatuses\.has\(job\.status\)/);
  assert.match(resetBlock, /DELETE FROM "history_import_channel_progress"/);
  assert.doesNotMatch(resetBlock, /DELETE FROM "discord_message"/);
});

test("dangerous deletion queues a Guild-scoped local deletion request without raw Cloud DELETE", () => {
  const deleteHandler = route.slice(route.indexOf("export async function DELETE"));
  assert.match(deleteHandler, /parseImportedDataDeletion/);
  assert.match(deleteHandler, /Cancel the active import before deleting imported history data/);
  assert.match(deleteHandler, /IMPORTED_HISTORY_DATA_DELETE_REQUESTED/);
  assert.match(deleteHandler, /requestId/);
  assert.doesNotMatch(deleteHandler, /DELETE FROM "discord_message"/);
  assert.doesNotMatch(deleteHandler, /DELETE FROM "history_import_job"/);
});

test("SQLite-first enablement is enforced per Guild for read, mutation, and deletion", () => {
  assert.match(route, /messageImportConfig\.sqliteFirstEnabled/);
  assert.match(route, /messageImportConfig\.isSqliteFirstGuild\(guildId\)/);
  assert.match(route, /messageImportConfig\.isSqliteFirstGuild\(input\.guildId\)/);
  assert.match(route, /messageImportConfig\.isSqliteFirstGuild\(deletion\.guildId\)/);
});

test("API responses expose safe errors but never legacy raw errors in v2 selection", () => {
  const selection = route.slice(route.indexOf("function safeJobSelect"), route.indexOf("export async function GET"));
  assert.match(selection, /"safeErrorCode"/);
  assert.match(selection, /"safeErrorSummary"/);
  assert.doesNotMatch(selection, /"error"/);
});
