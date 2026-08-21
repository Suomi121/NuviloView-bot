import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("migration enforces audit-entry deduplication and containment remains queued POST-only", async () => {
  const [migration, containRoute, apiHelper] = await Promise.all([
    readFile(new URL("../scripts/migrations/20260814-nuke-protection-v1.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/security/incidents/[id]/contain/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/nuke-protection-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /"auditLogEntryId" text NOT NULL UNIQUE/);
  assert.match(containRoute, /export async function POST/);
  assert.doesNotMatch(containRoute, /export async function GET/);
  assert.match(containRoute, /SECURITY_SCOPES\.contain/);
  assert.match(apiHelper, /getManagedGuilds/);
  assert.match(apiHelper, /guild\.ownerId === discordUserId/);
  assert.match(apiHelper, /security_action_request/);
});

test("Bot uses the audit-log Gateway event and moderation intent without full audit polling", async () => {
  const bot = await readFile(new URL("../discord-bot.mjs", import.meta.url), "utf8");
  assert.match(bot, /GatewayIntentBits\.GuildModeration/);
  assert.match(bot, /client\.on\("guildAuditLogEntryCreate"/);
  assert.match(bot, /nukeProtectionService\.handleAuditLogEntry/);
  assert.doesNotMatch(bot, /fetchAuditLogs\([^)]*limit:\s*100/);
});
