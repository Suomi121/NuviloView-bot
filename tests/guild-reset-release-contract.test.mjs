import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiSource = await readFile(new URL("../lib/guild-reset-api.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../lib/guild-reset-service.mjs", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../app/api/developer/guilds/[guildId]/reset/settings/route.ts", import.meta.url), "utf8");
const backupRouteSource = await readFile(new URL("../app/api/developer/guilds/[guildId]/reset/backups/route.ts", import.meta.url), "utf8");
const historyRouteSource = await readFile(new URL("../app/api/developer/guilds/[guildId]/reset/history/route.ts", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../app/developer/guilds/[guildId]/reset/page.tsx", import.meta.url), "utf8");

test("Guild Reset API binds developer identity to the connected Guild and per-Guild allow-list", () => {
  assert.match(apiSource, /getDeveloperAccess\(request\)/);
  assert.match(apiSource, /row\.ownerId !== access\.discordUserId/);
  assert.match(apiSource, /allowedAdminIds\.includes\(access\.discordUserId\)/);
  assert.match(apiSource, /WHERE registry\."guildId" = \$1/);
  assert.match(apiSource, /row\.resetEnabled !== true/);
  assert.match(apiSource, /error\.code === 'RATE_LIMIT'[\s\S]*\? 429/);
});

test("only the registered Guild owner can change reset settings", () => {
  assert.match(settingsSource, /context\.registry\.ownerId !== context\.access\.discordUserId/);
  assert.match(settingsSource, /status: 403/);
  assert.match(settingsSource, /assertResetMutation\(request\)/);
});

test("confirmation is explicit, transactionally consumed, and request-bound", () => {
  assert.match(apiSource, /body\.acknowledge !== true/);
  assert.match(apiSource, /FOR UPDATE/);
  assert.match(apiSource, /"usedAt" = now\(\), "usedByRequestId" = \$2/);
  assert.match(apiSource, /consumed\.rowCount !== 1/);
  assert.match(dashboardSource, /acknowledge: acknowledged/);
});

test("Guild Reset never expands into Analytics, Security, members, bans, or kicks", () => {
  for (const forbidden of [
    /DELETE FROM "discord_message"/,
    /DELETE FROM "daily_stats"/,
    /DELETE FROM "security_/,
    /DELETE FROM "reaction_role_rule"/,
    /\.members\.ban\(/,
    /\.members\.kick\(/,
  ]) {
    assert.doesNotMatch(serviceSource, forbidden);
  }
});

test("developer history is bounded, explicit, and does not expose Bot-host filesystem paths", () => {
  assert.doesNotMatch(settingsSource, /SELECT\s+\*/i);
  assert.doesNotMatch(historyRouteSource, /SELECT\s+\*/i);
  assert.doesNotMatch(backupRouteSource, /"filePath"/);
  assert.doesNotMatch(historyRouteSource, /"backupPath"/);
  assert.match(backupRouteSource, /LIMIT 50/);
  assert.match(historyRouteSource, /LIMIT 30/);
});

test("dashboard work is not processed while the global feature flag is disabled", () => {
  assert.match(serviceSource, /if \(!config\.enabled\) return null/);
  assert.match(serviceSource, /assertFeatureEnabled\(\)/);
});
