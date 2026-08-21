export const entertainmentCommandPrefix = "zx?";
export const defaultDiceSides = 10;
export const maxDiceCount = 50;
export const maxDiceSides = 1_000;
const discordNativeDiceCounts = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42]);
const discordNativeDiceSides = new Set([4, 6, 8, 10, 12, 20]);

export const entertainmentCommandDefinitions = Object.freeze([
  {
    name: "help",
    usage: "zx?help [command]",
    description: "娯楽コマンドの一覧または詳しい使い方を表示します。",
  },
  {
    name: "dice",
    usage: "zx?dice [10d | 2d6]",
    description:
      "対応するダイスはDiscord標準の本人名義ロールを開き、その他はBotが結果を表示します。",
  },
  {
    name: "snipe",
    usage: "zx?snipe",
    description: "90日以内に自分や他メンバーが削除した履歴を最大999,999件まで確認します。",
  },
]);

const definitionsByName = new Map(
  entertainmentCommandDefinitions.map((definition) => [
    definition.name,
    definition,
  ]),
);

export function getEntertainmentCommandDefinition(name) {
  return definitionsByName.get(String(name ?? "").toLowerCase()) ?? null;
}

export function parseEntertainmentCommand(content) {
  const trimmed = String(content ?? "").trim();
  if (!trimmed.toLowerCase().startsWith(entertainmentCommandPrefix)) return null;

  const commandText = trimmed.slice(entertainmentCommandPrefix.length).trim();
  if (!commandText) {
    return {
      name: "help",
      args: [],
      argumentText: "",
      definition: definitionsByName.get("help"),
    };
  }

  const commandMatch = commandText.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const rawName = commandMatch?.[1] ?? "";
  const argumentText = commandMatch?.[2]?.trim() ?? "";
  const name = rawName.toLowerCase();
  return {
    name,
    args: argumentText ? argumentText.split(/\s+/) : [],
    argumentText,
    definition: definitionsByName.get(name) ?? null,
  };
}

export function formatDiceNotation(count, sides, explicitSides = false) {
  return explicitSides || sides !== defaultDiceSides
    ? `${count}D${sides}`
    : `${count}D`;
}

export function parseDiceNotation(input) {
  const raw = String(input ?? "").trim();
  const unwrapped =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).trim() : raw;
  const normalized = unwrapped.toLowerCase() || "1d";
  const match = normalized.match(/^(\d{1,2})d(\d{1,4})?$/);
  if (!match) return null;

  const count = Number(match[1]);
  const explicitSides = Boolean(match[2]);
  const sides = explicitSides ? Number(match[2]) : defaultDiceSides;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > maxDiceCount ||
    !Number.isInteger(sides) ||
    sides < 2 ||
    sides > maxDiceSides
  ) {
    return null;
  }
  return {
    count,
    sides,
    notation: formatDiceNotation(count, sides, explicitSides),
  };
}

export function rollDice(dice, randomInteger) {
  if (
    !dice ||
    !Number.isInteger(dice.count) ||
    dice.count < 1 ||
    dice.count > maxDiceCount ||
    !Number.isInteger(dice.sides) ||
    dice.sides < 2 ||
    dice.sides > maxDiceSides ||
    typeof randomInteger !== "function"
  ) {
    throw new Error("Invalid dice configuration.");
  }
  const rolls = Array.from({ length: dice.count }, () => {
    const value = randomInteger(1, dice.sides + 1);
    if (!Number.isInteger(value) || value < 1 || value > dice.sides) {
      throw new Error("Random dice result was outside the requested range.");
    }
    return value;
  });
  return {
    rolls,
    total: rolls.reduce((sum, value) => sum + value, 0),
  };
}

export function canUseDiscordNativeDice(dice) {
  return Boolean(
    dice &&
      discordNativeDiceCounts.has(dice.count) &&
      discordNativeDiceSides.has(dice.sides),
  );
}

export function createDiscordNativeDiceUrl({
  guildId,
  channelId,
  count,
  sides,
}) {
  if (
    !/^\d{17,20}$/.test(String(guildId ?? "")) ||
    !/^\d{17,20}$/.test(String(channelId ?? "")) ||
    !canUseDiscordNativeDice({ count, sides })
  ) {
    throw new Error("Invalid Discord native dice link configuration.");
  }
  return (
    `https://discord.com/channels/${guildId}/${channelId}/roll-dice/` +
    `${count}d${sides}`
  );
}

export function createDiceRollCustomId({ count, sides }) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > maxDiceCount ||
    !Number.isInteger(sides) ||
    sides < 2 ||
    sides > maxDiceSides
  ) {
    throw new Error("Invalid dice reroll configuration.");
  }
  return `zxgame:dice:${count}:${sides}`;
}

export function parseDiceRollCustomId(customId) {
  const [namespace, action, rawCount, rawSides, legacyExecutorId, ...rest] = String(
    customId ?? "",
  ).split(":");
  const count = Number(rawCount);
  const sides = Number(rawSides);
  if (
    namespace !== "zxgame" ||
    action !== "dice" ||
    rest.length > 0 ||
    (legacyExecutorId !== undefined &&
      !/^\d{17,20}$/.test(legacyExecutorId)) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > maxDiceCount ||
    !Number.isInteger(sides) ||
    sides < 2 ||
    sides > maxDiceSides
  ) {
    return null;
  }
  return { count, sides };
}
