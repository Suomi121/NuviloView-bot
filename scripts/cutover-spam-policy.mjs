import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { createLocalStorage, createStorage } from '../lib/storage/index.mjs';
import { localStorageMigrations } from '../lib/storage/migrations.mjs';
import { createSpamPolicyAuthority } from '../lib/spam-policy-authority.mjs';
import { fenceSpamPolicyAuthority } from '../lib/spam-policy-cutover.mjs';

// No env-file loading, implicit migrations, Bot login, or service management.
// A reviewed plan lists the exact Guild set; do not infer it from cached data.
const planPath = process.argv.find(arg => arg.startsWith('--plan='))?.slice(7);
if (!planPath) throw new Error('Usage: --plan=reviewed-plan.json [--execute-fenced-cutover]');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
if (plan.guildIds?.length !== 17 || new Set(plan.guildIds).size !== 17) throw new Error('EXPECTED_EXACTLY_17_GUILDS');
if (plan.guildIds.some(id => typeof id !== 'string' || !/^\d{16,22}$/.test(id)) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(plan.writerId ?? '') || !/^[a-zA-Z0-9_-]{1,80}$/.test(plan.epoch ?? '') ||
    typeof plan.databaseHost !== 'string' || typeof plan.databaseName !== 'string') throw new Error('INVALID_CUTOVER_PLAN');
if (!process.argv.includes('--execute-fenced-cutover')) {
  console.log(JSON.stringify({ mode: 'plan-only', guildCount: 17, writerId: plan.writerId, epoch: plan.epoch,
    databaseHost: plan.databaseHost, databaseName: plan.databaseName,
    steps: ['Verify backups, stop all writers and drain in-flight commands', 'Apply reviewed fence migration separately',
      'Verify all 17 Auto Timeout OFF; fence PostgreSQL writes and snapshot atomically',
      'Import into the designated SQLite authority; keep auto execution OFF', 'Verify replicas before retiring backups'] }, null, 2));
} else {
  if (process.env.SPAM_POLICY_CUTOVER_APPROVED !== plan.epoch || process.env.LOCAL_STORAGE_ENABLED !== 'true' ||
      process.env.LOCAL_STORAGE_WRITE_ENABLED !== 'true' || !process.env.LOCAL_STORAGE_PATH ||
      process.env.SECURITY_V2_AUTO_EXECUTION === 'enabled') throw new Error('CUTOVER_GUARDS_NOT_SATISFIED');
  let target;
  try { target = new URL(process.env.DATABASE_URL ?? ''); }
  catch { throw new Error('CUTOVER_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== plan.databaseHost ||
      decodeURIComponent(target.pathname.slice(1)) !== plan.databaseName) throw new Error('CUTOVER_DATABASE_TARGET_MISMATCH');
  if (!isAbsolute(process.env.LOCAL_STORAGE_PATH) || !existsSync(process.env.LOCAL_STORAGE_PATH)) throw new Error('CUTOVER_EXISTING_SQLITE_REQUIRED');
  const preflight = createLocalStorage({ databasePath: process.env.LOCAL_STORAGE_PATH, readOnly: true, writeEnabled: false });
  try {
    const health = preflight.health.getStatus();
    if (!health.integrity.ok || health.schemaVersion !== localStorageMigrations.at(-1).version) throw new Error('CUTOVER_SQLITE_PREFLIGHT_FAILED');
  } finally { preflight.close(); }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  let storage;
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const snapshots = await fenceSpamPolicyAuthority(client, plan);
    // The cloud fence MUST be durable before SQLite can become writable.
    await client.query('COMMIT');
    storage = createStorage({ env: { ...process.env, SPAM_POLICY_AUTHORITY: 'sqlite' } });
    const authority = createSpamPolicyAuthority({ storage, writerId: plan.writerId, enabled: true });
    for (const snapshot of snapshots) authority.importFencedSnapshot(snapshot);
    console.log(JSON.stringify({ imported: snapshots.length, writerId: plan.writerId, epoch: plan.epoch, autoTimeout: false }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Never undo a committed fence automatically. Repeat the same plan to resume.
    console.error(`Cutover stopped: ${String(error.code ?? error.message).slice(0, 80)}`);
    process.exitCode = 1;
  } finally { storage?.close(); await client.end(); }
}
