import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSourceInventory,
  classifyBackupPath,
  scanTextForSecretTypes,
} from "../scripts/backup-source-inventory.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("backup source policy excludes secrets, generated output, logs, and private keys", () => {
  assert.equal(classifyBackupPath(".env").include, false);
  assert.equal(classifyBackupPath(".env.local").include, false);
  assert.equal(classifyBackupPath(".env.production").include, false);
  assert.equal(classifyBackupPath(".env.example").include, true);
  assert.equal(classifyBackupPath("node_modules/pkg/index.js").include, false);
  assert.equal(classifyBackupPath("output/report.pdf").include, false);
  assert.equal(classifyBackupPath("logs/bot.log").include, false);
  assert.equal(classifyBackupPath("keys/private.pem").include, false);
  assert.equal(classifyBackupPath("scripts/token-leak-check.mjs").include, true);
});

test("backup secret scan detects values without reporting the secret itself", () => {
  assert.deepEqual(scanTextForSecretTypes("API_KEY=\nCLIENT_SECRET=<configure-me>\n"), []);
  assert.deepEqual(scanTextForSecretTypes("const token = process.env.BOT_TOKEN;"), []);
  assert.deepEqual(scanTextForSecretTypes(["password = ", "a-real-looking-value-12345"].join("")), ["literal_secret_assignment"]);
  assert.deepEqual(scanTextForSecretTypes(["DATABASE_URL=postgres", "ql://user:password@db.invalid/app"].join("")), ["database_url_with_password"]);
  assert.deepEqual(scanTextForSecretTypes(["-----BEGIN ", "PRIVATE KEY-----\nnot-a-real-key"].join("")), ["private_key"]);
});

test("backup inventory keeps public source while excluding secret and generated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuviloview-backup-inventory-"));
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "logs"), { recursive: true });
    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(path.join(root, ".env.example"), "DATABASE_URL=\n");
    await writeFile(path.join(root, ".env.local"), "DATABASE_URL=postgresql://private.invalid\n");
    await writeFile(path.join(root, "scripts", "safe.mjs"), "export const value = 1;\n");
    await writeFile(path.join(root, "scripts", "bad.txt"), ["client_secret = ", "actual-looking-value-123456\n"].join(""));
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(path.join(root, "logs", "bot.log"), "ignored\n");
    const output = path.join(root, "inventory.txt");
    const result = await buildSourceInventory({ root, output });
    const listed = (await readFile(output, "utf8")).trim().split(/\r?\n/);
    assert.ok(listed.includes("package.json"));
    assert.ok(listed.includes(".env.example"));
    assert.ok(listed.includes("scripts/safe.mjs"));
    assert.ok(!listed.includes(".env.local"));
    assert.ok(!listed.some((item) => item.startsWith("node_modules/")));
    assert.equal(result.secretFindings.length, 1);
    assert.deepEqual(result.secretFindings[0], { path: "scripts/bad.txt", types: ["literal_secret_assignment"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup pipeline is single-generation, bounded, Secret-screened, and restore-verified", async () => {
  const server = await readFile(path.join(projectRoot, "scripts", "backup-server.ps1"), "utf8");
  const runner = await readFile(path.join(projectRoot, "scripts", "run-backup-forever.ps1"), "utf8");
  const verify = await readFile(path.join(projectRoot, "scripts", "verify-server-backup.ps1"), "utf8");
  const database = await readFile(path.join(projectRoot, "scripts", "backup-neon.ps1"), "utf8");

  assert.match(server, /Global\\NuviloViewBackupPipelineV2/);
  assert.match(server, /DestinationCopyAttempts/);
  assert.match(server, /Pow\(2, \$attempt - 1\)/);
  assert.match(server, /backup-source-inventory\.mjs/);
  assert.match(server, /containsSecrets = \$false/);
  assert.match(server, /FullArtifactGenerationAttempts/);
  assert.match(server, /NUVILOVIEW_BACKUP_ENCRYPTION_PASSPHRASE/);
  assert.doesNotMatch(server, /\.env\.local contains credentials/i);
  assert.match(runner, /backup-last-attempt\.json/);
  assert.match(runner, /will not be regenerated automatically again today/i);
  assert.doesNotMatch(runner, /retry in 5 minutes/i);
  assert.match(verify, /Server source archive extraction validation failed/);
  assert.match(verify, /pg_restore/i);
  assert.match(verify, /Assert-SafeArchiveEntries/);
  assert.match(database, /PGPASSWORD/);
  assert.doesNotMatch(database, /--dbname=\$databaseUrl/);
});

test("PowerShell backup scripts parse and the preflight dry run stays non-destructive", { skip: process.platform !== "win32" }, () => {
  const scripts = ["backup-neon.ps1", "backup-server.ps1", "verify-server-backup.ps1", "run-backup-forever.ps1"];
  for (const script of scripts) {
    const fullPath = path.join(projectRoot, "scripts", script);
    const parsed = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:NUVILOVIEW_PARSE_TARGET,[ref]$null,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}",
    ], { encoding: "utf8", env: { ...process.env, NUVILOVIEW_PARSE_TARGET: fullPath } });
    assert.equal(parsed.status, 0, `${script}: ${parsed.stdout}${parsed.stderr}`);
  }

  const dryRoot = path.join(os.tmpdir(), "nuviloview-backup-dry-run");
  const dryRun = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(projectRoot, "scripts", "backup-server.ps1"),
    "-DestinationRoots",
    dryRoot,
    "-DryRun",
  ], { encoding: "utf8", cwd: projectRoot, timeout: 30_000 });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}${dryRun.stderr}`);
  assert.match(dryRun.stdout, /ContainsSecrets\s*:\s*False/i);
  assert.match(dryRun.stdout, /FullArtifactGenerationAttempts\s*:\s*1/i);
});
