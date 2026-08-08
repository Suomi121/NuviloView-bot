import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSecurityPermissionChecks,
  extractConfirmation,
  getSecurityCommandDefinition,
  parseDiscordTargetId,
  parseSecurityCommand,
  securityPermissionCheckDefinitions,
  securityCommandDefinitions,
} from "../lib/prefix-security-commands.mjs";

test("security commands use the r? prefix", () => {
  assert.equal(parseSecurityCommand("/ban @user reason"), null);
  assert.equal(parseSecurityCommand("hello"), null);
  assert.equal(parseSecurityCommand("R?BAN <@12345678901234567> reason").name, "ban");
});

test("an empty r? invocation opens security help", () => {
  assert.deepEqual(parseSecurityCommand("r?"), {
    name: "help",
    args: [],
    argumentText: "",
    definition: getSecurityCommandDefinition("help"),
  });
});

test("every security command has a unique r? usage definition", () => {
  assert.equal(
    new Set(securityCommandDefinitions.map((definition) => definition.name)).size,
    securityCommandDefinitions.length,
  );
  for (const definition of securityCommandDefinitions) {
    assert.match(definition.usage, /^r\?/);
  }
});

test("Discord targets accept user mentions and raw IDs", () => {
  assert.equal(parseDiscordTargetId("<@12345678901234567>"), "12345678901234567");
  assert.equal(parseDiscordTargetId("<@!12345678901234567>"), "12345678901234567");
  assert.equal(parseDiscordTargetId("12345678901234567"), "12345678901234567");
  assert.equal(parseDiscordTargetId("@someone"), null);
});

test("confirmation is explicit and removed from the reason tokens", () => {
  assert.deepEqual(extractConfirmation(["reason", "--confirm"]), {
    confirmed: true,
    args: ["reason"],
  });
  assert.deepEqual(extractConfirmation(["reason"]), {
    confirmed: false,
    args: ["reason"],
  });
});

test("say and snipe are no longer registered as r? commands", () => {
  assert.equal(getSecurityCommandDefinition("say"), null);
  assert.equal(getSecurityCommandDefinition("snipe"), null);
  assert.equal(parseSecurityCommand("r?say hello").definition, null);
  assert.equal(getSecurityCommandDefinition("ping").usage, "r?ping");
  assert.deepEqual(parseSecurityCommand("r?ping").args, []);
});

test("permission check is registered without accepting arguments by definition", () => {
  assert.equal(
    getSecurityCommandDefinition("perm_check").usage,
    "r?perm_check",
  );
  assert.equal(
    parseSecurityCommand("R?PERM_CHECK").definition.name,
    "perm_check",
  );
});

test("permission checks require both actor and Bot capabilities", () => {
  const checks = evaluateSecurityPermissionChecks({
    actorPermissions: ["BanMembers", "ManageMessages"],
    botPermissions: ["BanMembers", "KickMembers", "ManageMessages"],
  });
  assert.equal(checks.length, securityPermissionCheckDefinitions.length);
  assert.equal(checks.find((check) => check.key === "ban").available, true);
  assert.equal(checks.find((check) => check.key === "kick").actorAllowed, false);
  assert.equal(checks.find((check) => check.key === "timeout").botAllowed, false);
  assert.equal(checks.find((check) => check.key === "clear").available, true);
});

test("Guild owner or Administrator satisfies the actor side only", () => {
  const checks = evaluateSecurityPermissionChecks({
    actorIsOwner: true,
    botPermissions: ["ModerateMembers"],
  });
  assert.ok(checks.every((check) => check.actorAllowed));
  assert.equal(checks.find((check) => check.key === "timeout").available, true);
  assert.equal(checks.find((check) => check.key === "ban").available, false);
});
