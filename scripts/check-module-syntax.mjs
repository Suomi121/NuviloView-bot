import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "node_modules",
  "output",
  "data",
  "logs",
]);
const files = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
  }
}

await visit(root);
const failures = [];
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    failures.push({ file: relative(root, file), output: `${result.stdout}${result.stderr}`.trim() });
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`${failure.file}\n${failure.output}`);
  process.exitCode = 1;
} else {
  console.log(`Syntax validation passed: ${files.length} JavaScript modules.`);
}
