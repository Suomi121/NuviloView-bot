import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseDiscordNativeDice,
  createDiscordNativeDiceUrl,
  createDiceRollCustomId,
  entertainmentCommandDefinitions,
  getEntertainmentCommandDefinition,
  parseDiceNotation,
  parseDiceRollCustomId,
  parseEntertainmentCommand,
  rollDice,
} from "../lib/entertainment-commands.mjs";

test("entertainment commands use the zx? prefix and default to help", () => {
  assert.equal(parseEntertainmentCommand("r?dice 10d"), null);
  assert.equal(parseEntertainmentCommand("zx?").name, "help");
  assert.equal(parseEntertainmentCommand("ZX?HELP").name, "help");
  assert.equal(parseEntertainmentCommand("zx?dice 10d").name, "dice");
});

test("every entertainment command has a unique zx? usage definition", () => {
  assert.equal(
    new Set(entertainmentCommandDefinitions.map(({ name }) => name)).size,
    entertainmentCommandDefinitions.length,
  );
  for (const definition of entertainmentCommandDefinitions) {
    assert.match(definition.usage, /^zx\?/);
  }
});

test("say is not registered while snipe remains a public zx? command", () => {
  const say = parseEntertainmentCommand("zx?say first line\nsecond  line");
  assert.equal(say.name, "say");
  assert.equal(say.definition, null);
  assert.equal(getEntertainmentCommandDefinition("say"), null);
  assert.equal(getEntertainmentCommandDefinition("snipe").usage, "zx?snipe");
});

test("dice accepts count-D and conventional count-D-sides notation", () => {
  assert.deepEqual(parseDiceNotation("10d"), {
    count: 10,
    sides: 10,
    notation: "10D",
  });
  assert.deepEqual(parseDiceNotation("[10D]"), {
    count: 10,
    sides: 10,
    notation: "10D",
  });
  assert.deepEqual(parseDiceNotation("2d6"), {
    count: 2,
    sides: 6,
    notation: "2D6",
  });
  assert.deepEqual(parseDiceNotation(""), {
    count: 1,
    sides: 10,
    notation: "1D",
  });
});

test("dice limits invalid or excessive input", () => {
  for (const input of ["0d", "51d", "1d1", "1d1001", "10", "10d extra"]) {
    assert.equal(parseDiceNotation(input), null);
  }
});

test("dice returns every roll and its total", () => {
  const sequence = [3, 7, 4];
  const result = rollDice(
    { count: 3, sides: 10 },
    () => sequence.shift(),
  );
  assert.deepEqual(result, { rolls: [3, 7, 4], total: 14 });
});

test("Discord native dice links are limited and channel-bound", () => {
  assert.equal(canUseDiscordNativeDice({ count: 10, sides: 20 }), true);
  assert.equal(canUseDiscordNativeDice({ count: 42, sides: 6 }), true);
  assert.equal(canUseDiscordNativeDice({ count: 11, sides: 20 }), false);
  assert.equal(canUseDiscordNativeDice({ count: 10, sides: 100 }), false);
  assert.equal(
    createDiscordNativeDiceUrl({
      guildId: "1216303889599565875",
      channelId: "1507737783404462130",
      count: 10,
      sides: 20,
    }),
    "https://discord.com/channels/1216303889599565875/1507737783404462130/roll-dice/10d20",
  );
  assert.throws(() =>
    createDiscordNativeDiceUrl({
      guildId: "not-a-guild",
      channelId: "1507737783404462130",
      count: 10,
      sides: 20,
    }),
  );
});

test("dice reroll button can be shared while preserving safe limits", () => {
  const customId = createDiceRollCustomId({
    count: 10,
    sides: 10,
  });
  assert.equal(customId, "zxgame:dice:10:10");
  assert.deepEqual(parseDiceRollCustomId(customId), {
    count: 10,
    sides: 10,
  });
  assert.deepEqual(
    parseDiceRollCustomId("zxgame:dice:10:10:932566725898158080"),
    { count: 10, sides: 10 },
  );
  assert.equal(parseDiceRollCustomId("zxgame:dice:51:10:932566725898158080"), null);
});
