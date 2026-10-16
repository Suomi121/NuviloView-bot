import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const route = readFileSync(new URL('../app/api/guilds/[guildId]/security/spam-policy/route.ts', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../components/guild-spam-policy-panel.tsx', import.meta.url), 'utf8');
const source = route.slice(route.indexOf('export async function DELETE')).replace('export async', 'async');
test('old DELETE returns Gone without accessing the policy DB', async () => {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [trusted, denied, expected] of [[true, false, 410], [false, false, 400], [true, true, 403]]) {
    const context = vm.createContext({
      isTrustedMutation: () => trusted,
      authorizeGuild: async () => denied ? { response: { status: 403 } } : { session: { user: {} } },
      NextResponse: { json: (body, options) => ({ body, ...options }) },
      pool: new Proxy({}, { get() { throw new Error('Retired endpoint must not access policy storage'); } }),
    });
    const run = vm.runInContext(code + '\nDELETE', context);
    const result = await run({}, { params: Promise.resolve({ guildId: '100000000000000001' }) });
    assert.equal(result.status, expected);
    if (expected === 410) assert.equal(result.body.code, 'SPAM_RESET_RETIRED');
  }
});
test('Dashboard has no Reset control or policy deletion request; save remains available', () => {
  assert.doesNotMatch(panel, /void reset\(|method: "DELETE"|RotateCcw|labels\.reset/);
  assert.match(panel, /method: "PUT"/);
  assert.match(panel, /applySpamProtectionStrength/);
  assert.doesNotMatch(route, /DELETE FROM\s+"guild_spam_policy"/);
});
