import assert from "node:assert/strict";
import test from "node:test";
import { escapeScopeText, formatScopeMessage, plainComponentText } from "../lib/scopeserver-utils.mjs";

function message(overrides = {}) {
  return {
    id: "123456789012345678",
    guildId: "223456789012345678",
    channelId: "323456789012345678",
    createdTimestamp: Date.UTC(2026, 6, 18, 8, 0, 0),
    content: "通常メッセージ",
    author: { id: "423456789012345678", username: "tester", globalName: null, bot: false },
    member: { displayName: "Tester" },
    system: false,
    webhookId: null,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    ...overrides,
  };
}

test("component labels remove control characters and respect Discord limits", () => {
  assert.equal(plainComponentText("  #general\n\troom  ", 100), "#general room");
  assert.equal(plainComponentText("x".repeat(120), 100).length, 100);
});

test("message text cannot trigger mentions or break code blocks", () => {
  const escaped = escapeScopeText("@everyone **alert** ```danger```", 360);
  assert.equal(escaped.includes("@everyone"), false);
  assert.equal(escaped.includes("```"), false);
  assert.match(escaped, /＠everyone/);
});

test("formatted messages include audit-safe metadata and neutralized content", () => {
  const formatted = formatScopeMessage(message({ content: "@here `danger`", author: { id: "423456789012345678", username: "bot", bot: true } }), 1);
  assert.match(formatted, /BOT/);
  assert.match(formatted, /投稿者ID/);
  assert.match(formatted, /Message ID/);
  assert.match(formatted, /https:\/\/discord\.com\/channels\/223456789012345678\/323456789012345678\/123456789012345678/);
  assert.equal(formatted.includes("@here"), false);
  assert.equal(formatted.includes("`danger`"), false);
});

test("empty messages describe attachments, embeds, and stickers without fetching contents", () => {
  const formatted = formatScopeMessage(message({
    content: "",
    attachments: new Map([["1", {}]]),
    embeds: [{ type: "rich" }],
    stickers: new Map([["2", {}]]),
  }), 1);
  assert.match(formatted, /本文なし/);
  assert.match(formatted, /添付 1件/);
  assert.match(formatted, /Embed 1件/);
  assert.match(formatted, /スタンプ 1件/);
});
