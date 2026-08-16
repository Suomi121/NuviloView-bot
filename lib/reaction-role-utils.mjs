const discordIdPattern = /^\d{16,22}$/;
const customEmojiPattern = /^<a?:[A-Za-z0-9_]{2,32}:(\d{16,22})>$/;
const visibleEmojiPattern = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F|\u20E3)/u;

export const REACTION_ROLE_LIMIT = 10;

export function parseReactionRoleEmoji(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input || input.length > 128) return null;

  const custom = customEmojiPattern.exec(input);
  if (custom) {
    return {
      key: `custom:${custom[1]}`,
      display: input,
      reactionValue: custom[1],
      custom: true,
    };
  }

  if (!visibleEmojiPattern.test(input) || /\s/u.test(input)) return null;
  const graphemes = [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(input)];
  if (graphemes.length !== 1) return null;
  return {
    key: `unicode:${input}`,
    display: input,
    reactionValue: input,
    custom: false,
  };
}

export function getDiscordReactionEmojiKey(emoji) {
  if (emoji?.id && discordIdPattern.test(String(emoji.id))) {
    return `custom:${emoji.id}`;
  }
  const name = typeof emoji?.name === "string" ? emoji.name : "";
  return name ? `unicode:${name}` : null;
}

export function normalizeReactionRoleIds(values, limit = REACTION_ROLE_LIMIT) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!discordIdPattern.test(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= limit) break;
  }
  return unique;
}

export function isReactionRoleMessageId(value) {
  return discordIdPattern.test(typeof value === "string" ? value.trim() : "");
}
