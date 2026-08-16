import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bot = await readFile(new URL("../discord-bot.mjs", import.meta.url), "utf8");
const migration = await readFile(new URL("../scripts/migrations/20260816-reaction-roles.sql", import.meta.url), "utf8");

test("setroll is an Administrator-only guild command with add, remove, and list", () => {
  const commandStart = bot.indexOf('const setRollCommand = new SlashCommandBuilder()');
  const commandEnd = bot.indexOf('const translateMessageCommand', commandStart);
  const definition = bot.slice(commandStart, commandEnd);
  assert.match(definition, /\.setName\("setroll"\)/);
  assert.match(definition, /setDefaultMemberPermissions\(PermissionFlagsBits\.Administrator\)/);
  for (const subcommand of ["add", "remove", "list"]) {
    assert.match(definition, new RegExp(`setName\\("${subcommand}"\\)`));
  }
  assert.match(definition, /index <= REACTION_ROLE_LIMIT/);
  assert.match(bot, /extendedCommands = \[[\s\S]*setRollCommand/);
});

test("reaction role changes are handled for add and remove without per-reaction DB reads", () => {
  assert.match(bot, /client\.on\("messageReactionAdd"[\s\S]*applyReactionRoleChange\(reaction, user, true\)/);
  assert.match(bot, /client\.on\("messageReactionRemove"[\s\S]*applyReactionRoleChange\(reaction, user, false\)/);
  const handlerStart = bot.indexOf("async function applyReactionRoleChange");
  const handlerEnd = bot.indexOf("async function requireGuildManager", handlerStart);
  const handler = bot.slice(handlerStart, handlerEnd);
  assert.match(handler, /reactionRoleRules\.get/);
  assert.doesNotMatch(handler, /await sql/);
});

test("setroll is dispatched by the interaction handler, not the message handler", () => {
  const interactionStart = bot.indexOf('client.on("interactionCreate"');
  const messageStart = bot.indexOf('client.on("messageCreate"', interactionStart);
  const interactionHandler = bot.slice(interactionStart, messageStart);
  const messageHandler = bot.slice(messageStart);
  assert.match(interactionHandler, /interaction\.commandName === "setroll"/);
  assert.doesNotMatch(messageHandler, /interaction\.commandName === "setroll"/);
});

test("reaction roles reject privileged, managed, everyone, and above-Bot roles", () => {
  for (const permission of [
    "Administrator", "ManageGuild", "ManageRoles", "ManageChannels",
    "ManageWebhooks", "BanMembers", "KickMembers", "ModerateMembers",
  ]) {
    assert.match(bot, new RegExp(`PermissionFlagsBits\\.${permission}`));
  }
  assert.match(bot, /role\.id === guild\.id/);
  assert.match(bot, /role\.managed/);
  assert.match(bot, /role\.position >= botMember\.roles\.highest\.position/);
});

test("reaction role migration is additive and uniquely keys message plus emoji", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "reaction_role_rule"/);
  assert.match(migration, /UNIQUE \("guildId", "messageId", "emojiKey"\)/);
  assert.match(migration, /jsonb_typeof\("roleIds"\) = 'array'/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM/);
});
