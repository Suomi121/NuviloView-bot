import { writeSync } from "node:fs";
const installed = new WeakMap();

export function createWorkerRedactor(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|DB_URL/i.test(name)) continue;
    values.add(value);
    try { const url = new URL(value); if (url.password) { values.add(url.password); values.add(decodeURIComponent(url.password)); } } catch { /* Not a URL. */ }
  }
  const secrets = [...values].sort((a, b) => b.length - a.length);
  return (input) => {
    let text = String(input ?? "");
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/(?:postgres(?:ql)?|https?|libsql):\/\/[^\s'"<>]+/gi, "[REDACTED_URL]")
      .replace(/\bBearer\s+[^\s'",}]+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
      .replace(/((?:password|token|secret|api_?key|authorization)\s*['"]?\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,}]+)/gi, "$1[REDACTED]");
  };
}

export function installWorkerCrashDiagnostics({ target = process, env = process.env, write = (text) => writeSync(2, text) } = {}) {
  if (installed.has(target)) return installed.get(target);
  const redact = createWorkerRedactor(env);
  const monitor = (error, origin) => {
    // Monitor only: no uncaughtException handler, no return-to-work, no exit override.
    try {
      write(`${JSON.stringify({ timestamp: new Date().toISOString(), category: "worker-fatal",
        origin: redact(origin).slice(0, 100), name: redact(error?.name).slice(0, 100),
        code: redact(error?.code).slice(0, 100), stack: redact(error?.stack ?? error).slice(0, 12000),
        causeCode: redact(error?.cause?.code).slice(0, 100) })}\n`);
    } catch { /* Diagnostics must not replace the original fatal termination. */ }
  };
  target.on("uncaughtExceptionMonitor", monitor);
  const remove = () => { target.removeListener("uncaughtExceptionMonitor", monitor); installed.delete(target); };
  installed.set(target, remove);
  return remove;
}
