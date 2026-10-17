import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { enrollSecurityV2, readSecurityV2, setSecurityV2Auto } from '../lib/security-v2-consent.mjs';
const route = readFileSync(new URL('../app/api/guilds/[guildId]/security/spam-policy/route.ts', import.meta.url), 'utf8');
const source = route.slice(route.indexOf('export async function PATCH'), route.indexOf('export async function PUT')).replace('export async', 'async');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
test('actual Web consent endpoint denies unauthenticated/other Guild/Google-only/untrusted without SQL', async () => {
  for (const status of [401,403,503,429,400]) {
    const context = vm.createContext({ isTrustedMutation: () => status !== 400, hasJsonBody: () => true,
      authorizeGuild: async () => ({ response: { status } }),
      NextResponse: { json: (body, options) => ({ body, ...options }) },
      pool: new Proxy({}, { get() { throw new Error('Unauthorized SQL'); } }) });
    const run = vm.runInContext(code + '\nPATCH', context);
    assert.equal((await run({}, { params: Promise.resolve({ guildId: '100000000000000002' }) })).status, status);
  }
});
test('Web uses the same explicit consent writer as Discord; detects failure and rejects reset', async () => {
  const calls = [];
  let fail = false;
  const context = vm.createContext({ isTrustedMutation: () => true, hasJsonBody: () => true,
    authorizeGuild: async () => ({ session: { user: { id: 'auth-fixture' } } }),
    NextResponse: { json: (body, options) => ({ body, ...options }) },
    safeFailure: () => ({ status: 503 }), enrollSecurityV2, readSecurityV2, setSecurityV2Auto,
    pool: { query: async (q, p) => {
      calls.push(p); if (fail) throw new Error('isolated failure');
      if (q.includes('WITH saved')) return { rows: [{ enabled: p[1], revision: 2 }] };
      if (q.includes('SELECT e.migration_state')) return { rows: [{ migration_state: 'complete', enabled: false, emergency_stop: true }] };
      return { rows: [] };
    } } });
  const run = vm.runInContext(code + '\nPATCH', context);
  const params = { params: Promise.resolve({ guildId: '100000000000000002' }) };
  const response = await run({ json: async () => ({ operation: 'off' }) }, params);
  assert.equal(response.body.auto.autoTimeout, false);
  assert.equal(calls[1][0], '100000000000000002');
  assert.equal(calls[1][1], false); assert.equal(calls[1][2], 'web:auth-fixture');
  calls.length = 0;
  assert.equal((await run({ json: async () => ({ operation: 'reset' }) }, params)).status, 400);
  assert.equal(calls.length, 0);
  fail = true;
  assert.equal((await run({ json: async () => ({ operation: 'on' }) }, params)).status, 503);
});
