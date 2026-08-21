import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("CI is read-only and does not deploy or mutate production", () => {
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /GUILD_RESET_ENABLED: "false"/);
  assert.match(workflow, /SECURITY_AUTO_CONTAINMENT_ENABLED: "false"/);
  assert.match(workflow, /DISTRIBUTED_SINGLETON_ENABLED: "false"/);
  assert.doesNotMatch(workflow, /\b(?:deploy|release|db:migrate|retention:execute)\b/i);
});

test("CI validates source, migrations, security, tests and build", () => {
  for (const command of [
    "npm ci",
    "npm run migration:validate",
    "npm run migration:drift:static",
    "npm run security:tokens",
    "npm run syntax:check",
    "npm run lint",
    "npx tsc --noEmit",
    "npm test",
    "npm run dependency:audit",
    "npm run build",
  ]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
