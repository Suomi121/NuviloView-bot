import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeGuildSpamPolicy } from '../lib/guild-spam-policy.mjs';
import { securityFixture, guild } from './helpers/quorum-fixture.mjs';
import {securityVerification} from '../lib/multi-db/recovery-state.mjs';

function route(runtime, denied = null) {
  const source = fs.readFileSync(new URL('../app/api/guilds/[guildId]/security/spam-policy/route.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function publicPolicy'));
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/export /g, '');
  const context = vm.createContext({
    process: { env: { SECURITY_V2_AUTO_EXECUTION: 'enabled' } },
    getSecurityCoordinator: async () => runtime,
    normalizeGuildSpamPolicy,
    securityVerification,
    isTrustedMutation: r => r.trusted !== false, hasJsonBody: () => true,
    authorizeGuild: async (_, id) => denied ? { response: { status: denied } } : id === guild
      ? { session: { user: { id: 'fixture' } } } : { response: { status: 403 } },
    NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) },
    safeFailure: (_, e) => ({ status: e?.code === 'MDB_REVISION_CONFLICT' ? 409 : 503 }),
    pool: new Proxy({}, { get() { throw new Error('NO_LEGACY_SQL_ALLOWED'); } }),
  });
  return vm.runInContext(code + '\n({GET,PUT,PATCH,DELETE})', context);
}
const params = id => ({ params: Promise.resolve({ guildId: id }) });

test('actual Web route + actual quorum: shared policy read/write, CAS conflict, consent isolation and untrusted denial', async t => {
  const f = await securityFixture(t), handlers = route({ security: f.security });
  const get = await handlers.GET({}, params(guild));
  assert.equal(get.status, 200); assert.equal(get.body.authority, 'cloud-quorum');
  const request = { json: async () => ({ policy: { ...get.body.policy, strength: 67 }, concurrency: get.body.concurrency, requestId: 'web-request' }) };
  const save = await handlers.PUT(request, params(guild));
  assert.equal(save.status, 200); assert.equal(save.body.policy.strength, 67);
  assert.equal(save.body.auto.autoTimeout, false);
  const conflict = await handlers.PUT({ json: async () => ({ ...(await request.json()), requestId: 'other-web' }) }, params(guild));
  assert.equal(conflict.status, 409);
  assert.equal((await handlers.PUT({ trusted: false }, params(guild))).status, 400);
  assert.equal((await handlers.GET({}, params('100000000000000002'))).status, 403);
  assert.equal((await handlers.DELETE({}, params(guild))).status, 410);
  const auto = await handlers.PATCH({ json: async () => ({ operation: 'on', requestId: 'auto-on', concurrency: save.body.concurrency }) }, params(guild));
  assert.equal(auto.status, 200); assert.equal(auto.body.auto.autoTimeout, true);
  f.faults.neon = true;
  assert.equal((await handlers.GET({}, params(guild))).status, 200);
  f.faults.supabase = true;
  assert.equal((await handlers.GET({}, params(guild))).status, 503);
});

test('Web unauthorized / Google-only / failed session checks never access quorum', async () => {
  for (const denied of [401,403,429,503]) {
    const handlers = route({ security: new Proxy({}, { get() { throw new Error('UNAUTHORIZED_QUORUM_ACCESS'); } }) }, denied);
    assert.equal((await handlers.GET({}, params(guild))).status, denied);
    assert.equal((await handlers.PUT({}, params(guild))).status, denied);
    assert.equal((await handlers.PATCH({}, params(guild))).status, denied);
  }
});
