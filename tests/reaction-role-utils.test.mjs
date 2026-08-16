import assert from "node:assert/strict";
import test from "node:test";
import {
  REACTION_ROLE_LIMIT,
  getDiscordReactionEmojiKey,
  isReactionRoleMessageId,
  normalizeReactionRoleIds,
  parseReactionRoleEmoji,
} from "../lib/reaction-role-utils.mjs";

test("reaction role emoji accepts one Unicode grapheme or a custom emoji mention", () => {
  assert.deepEqual(parseReactionRoleEmoji("✅"), {
    key: "unicode:✅",
    display: "✅",
    reactionValue: "✅",
    custom: false,
  });
  assert.deepEqual(parseReactionRoleEmoji("<a:dance:123456789012345678>"), {
    key: "custom:123456789012345678",
    display: "<a:dance:123456789012345678>",
    reactionValue: "123456789012345678",
    custom: true,
  });
});

test("reaction role emoji rejects text, multiple emoji, and Discord mentions", () => {
  for (const value of ["hello", "✅ 🎉", "✅🎉", "<@123456789012345678>", ""]) {
    assert.equal(parseReactionRoleEmoji(value), null);
  }
});

test("Discord reactions use a stable custom ID or Unicode key", () => {
  assert.equal(getDiscordReactionEmojiKey({ id: "123456789012345678", name: "yes" }), "custom:123456789012345678");
  assert.equal(getDiscordReactionEmojiKey({ id: null, name: "✅" }), "unicode:✅");
  assert.equal(getDiscordReactionEmojiKey({ id: null, name: null }), null);
});

test("role IDs are unique, valid, and bounded to ten", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `123456789012345${String(index).padStart(3, "0")}`);
  assert.equal(normalizeReactionRoleIds([...ids, ids[0], "invalid"]).length, REACTION_ROLE_LIMIT);
  assert.deepEqual(normalizeReactionRoleIds([ids[0], ids[0], ids[1]]), [ids[0], ids[1]]);
});

test("message IDs use Discord snowflake validation", () => {
  assert.equal(isReactionRoleMessageId("123456789012345678"), true);
  assert.equal(isReactionRoleMessageId("123"), false);
  assert.equal(isReactionRoleMessageId("not-an-id"), false);
});
