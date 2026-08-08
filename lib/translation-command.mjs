export const preferredTranslationLanguages = Object.freeze([
  { emoji: "🇯🇵", name: "日本語", code: "ja" },
  { emoji: "🇺🇸", name: "English", code: "en" },
  { emoji: "🇨🇳", name: "简体中文", code: "zh-Hans" },
  { emoji: "🇹🇼", name: "繁體中文", code: "zh-Hant" },
  { emoji: "🇰🇷", name: "한국어", code: "ko" },
  { emoji: "🇪🇸", name: "Español", code: "es" },
  { emoji: "🇫🇷", name: "Français", code: "fr" },
  { emoji: "🇩🇪", name: "Deutsch", code: "de" },
  { emoji: "🇮🇹", name: "Italiano", code: "it" },
  { emoji: "🇵🇹", name: "Português", code: "pt" },
  { emoji: "🇷🇺", name: "Русский", code: "ru" },
  { emoji: "🇺🇦", name: "Українська", code: "uk" },
  { emoji: "🇸🇦", name: "العربية", code: "ar" },
  { emoji: "🇮🇳", name: "हिन्दी", code: "hi" },
  { emoji: "🇮🇩", name: "Bahasa Indonesia", code: "id" },
  { emoji: "🇻🇳", name: "Tiếng Việt", code: "vi" },
  { emoji: "🇹🇭", name: "ไทย", code: "th" },
  { emoji: "🇹🇷", name: "Türkçe", code: "tr" },
  { emoji: "🇵🇱", name: "Polski", code: "pl" },
  { emoji: "🇳🇱", name: "Nederlands", code: "nl" },
  { emoji: "🇸🇪", name: "Svenska", code: "sv" },
  { emoji: "🇫🇮", name: "Suomi", code: "fi" },
  { emoji: "🇬🇷", name: "Ελληνικά", code: "el" },
]);

export function getTranslationAutocompleteChoices(input) {
  const query = String(input ?? "").trim().toLocaleLowerCase();
  return preferredTranslationLanguages
    .filter((language) =>
      `${language.name} ${language.code}`
        .toLocaleLowerCase()
        .includes(query),
    )
    .slice(0, 25)
    .map((language) => ({
      name: `${language.emoji} ${language.name} (${language.code})`.slice(0, 100),
      value: language.code,
    }));
}

export function resolveAvailableTranslationLanguage(input, availableLanguages) {
  const requested = String(input ?? "").trim().toLocaleLowerCase();
  if (!requested || !Array.isArray(availableLanguages)) return null;
  return (
    availableLanguages.find(
      (language) =>
        typeof language?.code === "string" &&
        language.code.toLocaleLowerCase() === requested,
    ) ?? null
  );
}
