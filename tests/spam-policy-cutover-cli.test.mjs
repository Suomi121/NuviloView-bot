import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('cutover CLI defaults to a disconnected plan and refuses execution without guards', t => {
  const root = mkdtempSync(join(tmpdir(), 'spam-cutover-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'plan.json');
  writeFileSync(path, JSON.stringify({ guildIds: Array.from({ length: 17 }, (_, n) => String(200000000000000001n + BigInt(n))),
    writerId: 'isolated-writer', epoch: 'isolated-epoch', databaseHost: 'unreachable.invalid', databaseName: 'isolated' }));
  const env = { ...process.env, DATABASE_URL: 'postgresql://invalid:invalid@unreachable.invalid/isolated',
    LOCAL_STORAGE_ENABLED: 'false', SPAM_POLICY_CUTOVER_APPROVED: '' };
  const script = new URL('../scripts/cutover-spam-policy.mjs', import.meta.url);
  const run = flags => spawnSync(process.execPath, [fileURLToPath(script), `--plan=${path}`, ...flags], { env, encoding: 'utf8', timeout: 5000 });
  const plan = run([]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).mode, 'plan-only');
  const refused = run(['--execute-fenced-cutover']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /CUTOVER_GUARDS_NOT_SATISFIED/);
  assert.doesNotMatch(refused.stderr, /ENOTFOUND|ECONNREFUSED/);
});
