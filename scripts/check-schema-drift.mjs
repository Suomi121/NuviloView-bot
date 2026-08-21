import { readdir, readFile } from "node:fs/promises";

const schemaSource = await readFile(new URL("../lib/db/schema.ts", import.meta.url), "utf8");
const migrationDirectory = new URL("./migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"));
const migrationSources = await Promise.all(migrationFiles.map((name) => readFile(new URL(name, migrationDirectory), "utf8")));
const bootstrapSource = await readFile(new URL("./migrate.mjs", import.meta.url), "utf8");
const sqlSource = [bootstrapSource, ...migrationSources].join("\n");

function matches(source, expression) {
  return new Set([...source.matchAll(expression)].map((match) => match[1]));
}

const schemaTables = matches(schemaSource, /\bpgTable\s*\(\s*"([^"]+)"/g);
const migrationTables = matches(sqlSource, /\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/gi);
const schemaIndexes = matches(schemaSource, /\b(?:index|uniqueIndex)\("([^"]+)"\)/g);
const migrationIndexes = new Set([
  ...matches(sqlSource, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/gi),
  ...matches(sqlSource, /\bCONSTRAINT\s+"([^"]+)"\s+UNIQUE\b/gi),
]);
const externallyManagedTables = new Set(["user", "session", "account", "verification"]);
const retainedLegacyTables = new Set(["guild_public_report"]);
const constraintBackedSchemaIndexes = new Set([
  "bot_channel_access_guild_channel_unique",
  "guild_channel_registry_guild_channel_unique",
  "guild_role_registry_guild_role_unique",
  "security_incident_action_audit_entry_unique",
  "security_trusted_actor_guild_actor_unique",
]);

const missingTableMigrations = [...schemaTables].filter((name) => !migrationTables.has(name) && !externallyManagedTables.has(name)).sort();
const missingSchemaModels = [...migrationTables].filter((name) => !schemaTables.has(name) && !retainedLegacyTables.has(name) && !externallyManagedTables.has(name)).sort();
const missingIndexMigrations = [...schemaIndexes].filter((name) => !migrationIndexes.has(name) && !constraintBackedSchemaIndexes.has(name)).sort();
const errors = [
  ...missingTableMigrations.map((name) => `Schema table has no migration: ${name}`),
  ...missingSchemaModels.map((name) => `Migration table has no schema model: ${name}`),
  ...missingIndexMigrations.map((name) => `Schema index has no migration/bootstrap definition: ${name}`),
];

if (errors.length > 0) {
  for (const error of errors) console.error(`Static schema drift: ${error}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "ok",
    schemaTables: schemaTables.size,
    schemaIndexes: schemaIndexes.size,
    externallyManagedTables: [...externallyManagedTables],
    retainedLegacyTables: [...retainedLegacyTables],
    constraintBackedSchemaIndexes: [...constraintBackedSchemaIndexes],
  }));
}
