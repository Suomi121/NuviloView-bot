import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStorage } from '../lib/storage/index.mjs';
import { createSpamPolicyAuthority } from '../lib/spam-policy-authority.mjs';
import { DEFAULT_GUILD_SPAM_POLICY } from '../lib/guild-spam-policy.mjs';
import { getProviderPolicyDefinitions } from '../lib/sync/providers/contract.mjs';
import { loadSpamCommand, interaction } from './helpers/spam-command-harness.mjs';

const guildId = '100000000000000001', actorId = '100000000000000003', requestId = '100000000000000004';
const writerId = 'isolated-writer', epoch = 'isolated-epoch';
const env = { MULTI_DB_SYNC_ENABLED: 'true', SYNC_NEON_ENABLED: 'true', SYNC_SUPABASE_ENABLED: 'true', SYNC_TURSO_ENABLED: 'true' };
const snapshot = { guildId, writerId, epoch, fenced: true, autoTimeout: false, policy: DEFAULT_GUILD_SPAM_POLICY };
const change = { guildId, actorId, requestId, operation: 'level', value: 75, expectedRevision: 1 };
function fixture(t, options = {}) {
  const storage = createLocalStorage({ databasePath: ':memory:', providerDefinitions: getProviderPolicyDefinitions(env), ...options });
  t.after(() => storage.close());
  const authority = createSpamPolicyAuthority({ storage, writerId, enabled: true });
  authority.importFencedSnapshot(snapshot);
  return { storage, authority };
}

test('17 Guild imports and level update preserve OFF and isolate policies; all replicas receive delivery records', t => {
  const { storage, authority } = fixture(t);
  for (let n = 2; n <= 17; n++) authority.importFencedSnapshot({ ...snapshot, guildId: String(BigInt(guildId) + BigInt(n - 1)) });
  assert.equal(authority.update(change).policy.strength, 75);
  assert.equal(authority.read(String(BigInt(guildId) + 1n)).policy.strength, 50);
  const event = storage.outbox.getByEventId(`spam-policy-command:${guildId}:${requestId}`);
  assert.equal(event.payload.autoTimeout, false);
  assert.equal(event.payload.revision, 2);
  assert.deepEqual(storage.providerDeliveries.listForEvent(event.eventId).map(x => x.providerId), ['neon', 'supabase', 'turso']);
  assert.equal(storage.security.getByEventId(event.eventId).payload.checksum, event.payload.checksum);
});

test('idempotent replay, stale concurrent revision, and request collision', t => {
  const { authority } = fixture(t);
  authority.update(change);
  assert.equal(authority.update(change).revision, 2);
  assert.throws(() => authority.update({ ...change, requestId: '100000000000000005' }), /REVISION_CONFLICT/);
  assert.throws(() => authority.update({ ...change, value: 1 }), /REQUEST_COLLISION/);
  assert.throws(() => authority.update({ ...change, expectedRevision: 2, requestId: '100000000000000006', operation: 'reset' }), /OPERATION_DENIED/);
  assert.equal(authority.read(guildId).policy.strength, 75);
});

for (const stage of ['audit', 'outbox']) test(`${stage} failure rolls back policy, audit and deliveries`, t => {
  const { storage, authority } = fixture(t);
  const broken = { ...storage, ...(stage === 'audit' ? { security: { ...storage.security, appendAudit() { throw new Error('disk full'); } } }
    : { outbox: { ...storage.outbox, enqueue() { throw new Error('disk full'); } } }) };
  const service = createSpamPolicyAuthority({ storage: broken, writerId, enabled: true });
  assert.throws(() => service.update(change), /disk full/);
  assert.equal(authority.read(guildId).revision, 1);
  const eventId = `spam-policy-command:${guildId}:${requestId}`;
  assert.equal(storage.security.getByEventId(eventId), null);
  assert.equal(storage.outbox.getByEventId(eventId), null);
  assert.deepEqual(storage.providerDeliveries.listForEvent(eventId), []);
});

test('restart preserves pending state; re-import never resets a newer revision', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-authority-'));
  let reopened;
  t.after(() => { reopened?.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'isolated.sqlite');
  const first = createLocalStorage({ databasePath: path });
  const a = createSpamPolicyAuthority({ storage: first, writerId, enabled: true });
  a.importFencedSnapshot(snapshot); a.update(change); first.close();
  const { authority, storage } = fixture(t, { databasePath: path });
  reopened = storage;
  assert.equal(authority.read(guildId).revision, 2);
  assert.equal(authority.read(guildId).policy.strength, 75);
  assert.ok(storage.outbox.getByEventId(`spam-policy-command:${guildId}:${requestId}`));
});

test('missing seed, wrong writer, corrupt policy and unfenced/ON import fail closed', t => {
  const { storage, authority } = fixture(t);
  assert.throws(() => authority.read('100000000000000099'), /NOT_IMPORTED/);
  assert.throws(() => authority.importFencedSnapshot({ ...snapshot, autoTimeout: true }), /IMPORT_INVALID/);
  assert.throws(() => authority.importFencedSnapshot({ ...snapshot, fenced: false }), /IMPORT_INVALID/);
  const other = createSpamPolicyAuthority({ storage, writerId: 'other', enabled: true });
  assert.throws(() => other.read(guildId), /AUTHORITY_INVALID/);
  const name = `spam-policy-authority:v1:${guildId}`;
  const record = storage.syncMetadata.get(name);
  storage.syncMetadata.set({ streamName: name, state: 'active', metadata: { ...record.metadata, checksum: 'corrupt' } });
  assert.throws(() => authority.read(guildId), /AUTHORITY_INVALID/);
});

test('actual level handler ACKs before fresh authorization and persists with Neon completely unavailable', async t => {
  const { authority } = fixture(t);
  const i = interaction('level'); i.id = requestId;
  i.guild = { roles: { fetch: async () => { assert.equal(i.deferred, true); } }, members: { fetch: async options => {
    assert.equal(i.deferred, true); assert.equal(options.force, true);
    return { permissions: { has: p => p === 'manage' } };
  } } };
  const h = loadSpamCommand({ authority, query: async () => { assert.fail('No cloud access allowed'); } });
  await h.run(i);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
  assert.equal(h.warnings.length, 0);
  assert.match(i.replies[0].content, /75 \/ 100/);
  assert.equal(authority.read(guildId).revision, 2);
});

test('revoked permission after Interaction creation cannot write', async t => {
  const { authority } = fixture(t);
  const i = interaction('level'); i.id = requestId;
  i.guild = { roles: { fetch: async () => {} }, members: { fetch: async () => ({ permissions: { has: () => false } }) } };
  await loadSpamCommand({ authority }).run(i);
  assert.equal(authority.read(guildId).revision, 1);
  assert.match(i.replies[0].content, /管理者/);
});

test('auto on remains OFF in SQLite mode without a cloud write', async t => {
  const { authority } = fixture(t);
  const i = interaction('on'); i.options.getSubcommandGroup = () => 'auto';
  await loadSpamCommand({ authority }).run(i);
  assert.match(i.replies[0].content, /Auto Timeout: OFF/);
  assert.equal(authority.read(guildId).revision, 1);
});

test('legacy level DB failure has an early ACK and no unsafe second initial reply', async () => {
  const i = interaction('level');
  const h = loadSpamCommand({ get: async () => {
    assert.equal(i.deferred, true); return { source: 'fallback', policy: null };
  } });
  await h.run(i);
  assert.deepEqual(i.responseMethods, ['defer', 'edit']);
  assert.match(i.replies[0].content, /保存できません/);
});
