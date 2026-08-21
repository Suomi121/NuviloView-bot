import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".cache",
  ".vercel",
  "backups",
  "coverage",
  "credentials",
  "logs",
  "node_modules",
  "output",
  "secrets",
  "temp",
  "tmp",
  "tokens",
]);

const PUBLIC_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_FILE_NAMES = new Set([
  "credentials",
  "credentials.json",
  "oauth-token.json",
  "oauth-tokens.json",
  "secrets",
  "secrets.json",
  "token-cache.json",
  "tokens",
  "tokens.json",
]);
const TEMPORARY_SUFFIXES = [".bak", ".intent-test-backup", ".log", ".swp", ".temp", ".tmp", ".tsbuildinfo", "~"];
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

function normalizeRelativePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function classifyBackupPath(relativePath, { isDirectory = false } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const baseName = lowerSegments.at(-1) ?? "";

  if (lowerSegments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return { include: false, reason: "excluded_directory" };
  }
  if (isDirectory) return { include: true, reason: null };
  if (baseName === ".env" || (baseName.startsWith(".env.") && !PUBLIC_ENV_TEMPLATES.has(baseName))) {
    return { include: false, reason: "environment_secret" };
  }
  if (SECRET_FILE_NAMES.has(baseName)) return { include: false, reason: "secret_file_name" };
  if (baseName.endsWith(".pem") || baseName.endsWith(".key") || baseName.endsWith(".pfx") || baseName.endsWith(".p12")) {
    return { include: false, reason: "private_key_material" };
  }
  if (TEMPORARY_SUFFIXES.some((suffix) => baseName.endsWith(suffix))) {
    return { include: false, reason: "temporary_or_log_file" };
  }
  if (normalized.includes("\n") || normalized.includes("\r")) {
    return { include: false, reason: "unsupported_file_name" };
  }
  return { include: true, reason: null };
}

function isPlaceholder(value) {
  const normalized = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!normalized) return true;
  return /^(?:null|undefined|false|true)$/i.test(normalized)
    || /(?:example|placeholder|change-?me|your[_-]|dummy|redacted|test[_-]?only|<[^>]+>|\*{3,}|x{4,})/i.test(normalized)
    || /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?/i.test(normalized)
    || /process\.env|import\.meta\.env|\$\{|%[A-Z0-9_]+%/i.test(normalized)
    || /^[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(normalized)
    || /^(?:string|number|boolean)\b/.test(normalized)
    || /^[A-Za-z_$][\w$]*\s*\(/.test(normalized);
}

export function scanTextForSecretTypes(content) {
  const value = String(content ?? "");
  const findings = new Set();
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) findings.add("private_key");
  if (/\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i.test(value)) findings.add("database_url_with_password");
  if (/https:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/i.test(value)) findings.add("discord_webhook");
  if (/\b(?:mfa\.[\w-]{20,}|[\w-]{24,}\.[\w-]{6}\.[\w-]{20,})\b/.test(value)) findings.add("discord_token");

  const assignmentPattern = /^\s*["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*(.+?)\s*[,;]?\s*$/gim;
  for (const match of value.matchAll(assignmentPattern)) {
    if (!isPlaceholder(match[1]) && match[1].replace(/^['"]|['"]$/g, "").length >= 12) {
      findings.add("literal_secret_assignment");
    }
  }
  return [...findings].sort();
}

async function isBinaryFile(filePath) {
  const handle = await import("node:fs/promises").then(({ open }) => open(filePath, "r"));
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function buildSourceInventory({ root, output }) {
  const rootPath = path.resolve(root);
  const rootRealPath = await realpath(rootPath);
  const included = [];
  const excludedCounts = new Map();
  const secretFindings = [];

  const recordExclusion = (reason) => excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);

  async function visit(directoryPath, relativeDirectory = "") {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
      const absolutePath = path.join(directoryPath, entry.name);
      const classification = classifyBackupPath(relativePath, { isDirectory: entry.isDirectory() });
      if (!classification.include) {
        recordExclusion(classification.reason);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolutePath);
        const relativeTarget = path.relative(rootRealPath, target);
        if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
          recordExclusion("external_symbolic_link");
          continue;
        }
        included.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        recordExclusion("unsupported_file_type");
        continue;
      }

      included.push(relativePath);
      const file = await lstat(absolutePath);
      if (file.size > MAX_SCANNED_FILE_BYTES || await isBinaryFile(absolutePath)) continue;
      const content = await readFile(absolutePath, "utf8");
      const types = scanTextForSecretTypes(content);
      if (types.length) secretFindings.push({ path: relativePath, types });
    }
  }

  await visit(rootPath);
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  // Windows bsdtar treats a trailing blank line in -T input as an empty path.
  await writeFile(output, included.join("\n"), { encoding: "utf8", mode: 0o600 });
  return {
    root: rootPath,
    output: path.resolve(output),
    includedFileCount: included.length,
    excludedFileCount: [...excludedCounts.values()].reduce((total, count) => total + count, 0),
    excludedByReason: Object.fromEntries([...excludedCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    secretFindings,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--root" || name === "--output") options[name.slice(2)] = argv[++index];
    else throw new Error(`Unsupported argument: ${name}`);
  }
  if (!options.root || !options.output) throw new Error("--root and --output are required.");
  return options;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const inventory = await buildSourceInventory(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(inventory)}\n`);
    if (inventory.secretFindings.length) process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`Backup source inventory failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
  }
}
