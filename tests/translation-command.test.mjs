import test from "node:test";
import assert from "node:assert/strict";
import {
  getTranslationAutocompleteChoices,
  resolveAvailableTranslationLanguage,
} from "../lib/translation-command.mjs";

test("translation autocomplete finds languages by name and code", () => {
  assert.deepEqual(getTranslationAutocompleteChoices("日本"), [
    { name: "🇯🇵 日本語 (ja)", value: "ja" },
  ]);
  assert.deepEqual(getTranslationAutocompleteChoices("zh").map(({ value }) => value), [
    "zh-Hans",
    "zh-Hant",
  ]);
  assert.ok(getTranslationAutocompleteChoices("").length <= 25);
});

test("translation target resolution is case-insensitive and availability-bound", () => {
  const availableLanguages = [
    { code: "ja", name: "Japanese" },
    { code: "zh-Hans", name: "Chinese (Simplified)" },
  ];
  assert.deepEqual(
    resolveAvailableTranslationLanguage("ZH-hans", availableLanguages),
    availableLanguages[1],
  );
  assert.equal(
    resolveAvailableTranslationLanguage("en", availableLanguages),
    null,
  );
});
