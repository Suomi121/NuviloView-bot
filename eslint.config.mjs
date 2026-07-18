import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    files: ["app/**/*.tsx", "components/**/*.tsx"],
    rules: {
      // These legacy views intentionally initialize local UI state from
      // effects. Migrate them separately instead of changing runtime behavior
      // as part of an unrelated Bot command release.
      "react-hooks/set-state-in-effect": "off",
      // Several shared brand links deliberately force a full landing-page
      // navigation so authentication routing is re-evaluated.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".vercel/**",
    "backups/**",
    "logs/**",
    "companion/dist/**",
    "next-env.d.ts",
  ]),
]);
