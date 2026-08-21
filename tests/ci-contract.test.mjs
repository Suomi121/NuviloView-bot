import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("CI is read-only and does not deploy or mutate production", () => {
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /GUILD_RESET_ENABLED: "false"/);
  assert.match(workflow, /NUVILOVIEW_NUKE_PROTECTION: "false"/);
  assert.match(workflow, /NUVILOVIEW_DISTRIBUTED_SINGLETON: "false"/);
  assert.match(workflow, /MESSAGE_HISTORY_IMPORT_V2_ENABLED: "false"/);
  assert.doesNotMatch(workflow, /\b(?:deploy|release|db:migrate|retention:execute)\b/i);
});

test("CI validates source, migrations, security, tests and build", () => {
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm run migration:validate",
    "pnpm run migration:drift:static",
    "pnpm run security:tokens",
    "pnpm run syntax:check",
    "pnpm run lint",
    "pnpm exec tsc --noEmit",
    "pnpm test",
    "pnpm run dependency:audit",
    "pnpm run build",
  ]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
