import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { ChannelType, Events } from 'discord.js';
import { smokeConfig, openSmokeState, smokeLogPayload, registerSmokeInteractions, runSmoke, PRODUCTION_BOT_IDS } from '../scripts/lib/security-evidence-smoke.mjs';
import { evidenceFixture, botId, receiver } from './helpers/security-evidence-fixture.mjs';
import { guildId, roleId } from './helpers/security-operator-fixture.mjs';
import { securityLogFingerprint } from '../lib/security-evidence-components.mjs';
import { evidenceText } from '../lib/security-evidence.mjs';
const env = { SECURITY_SMOKE_SESSION: 'isolated-test', SECURITY_SMOKE_APPLICATION_ID: botId,
  SECURITY_SMOKE_GUILD_ID: guildId, SECURITY_SMOKE_LOG_CHANNEL_ID: '400000000000000001', SECURITY_SMOKE_OPERATOR_ROLE_IDS: roleId };

test('smoke never accepts Production environment, inherited credentials, or the known Production Application ID', () => {
  for (const key of ['VERCEL', 'VERCEL_ENV', 'CI', 'NUVILOVIEW_BOT_TOKEN', 'DATABASE_URL', 'WEB_AUTH_SUPABASE_DATABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'TURSO_AUTH_TOKEN', 'LOCAL_STORAGE_PATH', 'NUVILOVIEW_PROJECT_ROOT']) {
    assert.throws(() => smokeConfig({ ...env, [key]: 'not-a-real-secret' }), /PRODUCTION_ENV_DENIED/);
  }
  assert.throws(() => smokeConfig({ ...env, NODE_ENV: 'production' }), /PRODUCTION_ENV_DENIED/);
  assert.throws(() => smokeConfig({ ...env, SECURITY_SMOKE_APPLICATION_ID: PRODUCTION_BOT_IDS[0] }), /TEST_IDS_REQUIRED/);
  assert.throws(() => smokeConfig({ ...env, SECURITY_SMOKE_SESSION: '../data' }), /SESSION_REQUIRED/);
  assert.throws(() => smokeConfig({ ...env, SECURITY_REPORT_CHANNEL_ID: 'wrong' }), /RECEIVER_INVALID/);
});
test('plan is network-free and file-free; connect requires explicit opt-in and test-specific token', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'nuviloview-smoke-plan-')); const output = [];
  try {
    await runSmoke({ env, args: ['--plan'], root, print: v => output.push(v), makeClient: () => { throw new Error('NETWORK'); } });
    assert.equal(fs.readdirSync(root).length, 0); assert.equal(output[0].network, 'NONE');
    await assert.rejects(runSmoke({ env, args: ['--connect-test-bot'], root }), /EXPLICIT_CONNECT_REQUIRED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('dedicated SQLite synthetic fixture persists across restart, is labelled, and singleton / config drift fails closed', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'nuviloview-smoke-state-')); const config = smokeConfig(env);
  let state;
  try {
    state = openSmokeState(config, { root }); state.seed();
    assert.throws(() => openSmokeState(config, { root }), /EEXIST/);
    const id = state.incidentId, snapshot = state.incidents.snapshot(guildId, id);
    assert.match(evidenceText(snapshot).toString(), /ISOLATED_SYNTHETIC/);
    assert.match(evidenceText(snapshot).toString(), /実際のDiscord Timeoutは実行していません/);
    const payload = smokeLogPayload(snapshot, null).embeds[0].toJSON();
    assert.match(payload.title, /隔離テスト/); assert.match(payload.description, /Timeout操作は行っていません/);
    assert.match(payload.description, /1日タイムアウト/); // explicitly simulated, actual renderer reused
    state.close(); state = null;
    assert.throws(() => openSmokeState({ ...config, channelId: '400000000000000008' }, { root }), /CONFIG_CHANGED/);
    state = openSmokeState(config, { root }); assert.equal(state.incidentId, id); assert.equal(state.seed().inserted, false);
    assert.equal(state.inspect().status, 'NOT_REPORTED');
  } finally { state?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('unmarked DB and linked fixture paths are rejected, never adopted as a Production database', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'nuviloview-smoke-path-')); const config = smokeConfig(env);
  const directory = path.join(root, 'output', 'security-evidence-smoke', config.session);
  try {
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'smoke.sqlite'), 'not a database');
    assert.throws(() => openSmokeState(config, { root }), /UNMARKED_DATABASE/);
    fs.unlinkSync(path.join(directory, 'smoke.sqlite'));
    fs.symlinkSync(tmpdir(), path.join(directory, 'smoke.sqlite'), 'junction');
    assert.throws(() => openSmokeState(config, { root }), /UNSAFE_PATH/);
    fs.unlinkSync(path.join(directory, 'smoke.sqlite'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('persistent handler listener can be removed and re-registered, valid evidence TXT still opens as UTF8', async () => {
  const f = evidenceFixture(); try {
    const emitter = new EventEmitter(); Object.assign(emitter, f.client);
    const state = { ...f, query: async () => ({ rows: [] }) };
    let off = registerSmokeInteractions(emitter, smokeConfig(env), state);
    const dispatch = async i => { i.isButton = () => true; for (const callback of emitter.listeners(Events.InteractionCreate)) await callback(i); };
    await dispatch(f.interaction()); assert.ok(f.replies[0].files);
    const bytes = f.replies[0].files[0].attachment;
    assert.ok(Buffer.isBuffer(bytes)); assert.ok(Buffer.from(bytes.toString('utf8')).equals(bytes));
    off(); assert.equal(emitter.listenerCount(Events.InteractionCreate), 0);
    off = registerSmokeInteractions(emitter, smokeConfig(env), state);
    // New handler limiter, same persisted SQLite Incident and stored message.
    await dispatch(f.interaction()); assert.ok(f.replies[1].files); off();
  } finally { f.storage.close(); }
});
test('report through the persistent Gateway listener is marked synthetic, exactly once after reopening SQLite', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'nuviloview-smoke-report-'));
  const databasePath = path.join(root, 'isolated.sqlite');
  const config = smokeConfig({ ...env, SECURITY_REPORT_GUILD_ID: receiver.guildId, SECURITY_REPORT_CHANNEL_ID: receiver.channelId });
  let f;
  let attempts = 0;
  async function click() {
    const emitter = new EventEmitter(); Object.assign(emitter, f.client);
    const off = registerSmokeInteractions(emitter, config, { ...f, query: async () => ({ rows: [] }) },
      { deliver: async (channel, payload) => {
        attempts++; assert.match(payload.content, /隔離テスト／合成記録/);
        assert.match(payload.files[0].attachment.toString('utf8'), /SUSPECTED_FALSE_POSITIVE/);
        return channel.send(payload);
      } });
    try {
      const i = f.interaction('r'); i.isButton = () => true;
      for (const handler of emitter.listeners(Events.InteractionCreate)) await handler(i);
    } finally { off(); }
  }
  try {
    f = evidenceFixture({ databasePath }); await click();
    assert.equal(attempts, 1); assert.match(f.replies[0].content, /送信したよ/); f.storage.close();
    f = evidenceFixture({ databasePath, existing: true }); await click();
    assert.equal(attempts, 1); assert.match(f.replies[0].content, /SENT/);
  } finally { f?.storage.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('complete Gateway startup / synthetic send / edit / shutdown path uses mocks with zero moderation or command writes', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'nuviloview-smoke-gateway-')); const outputs = [], writes = [];
  let loggedIn = 0, destroyed = 0;
  const client = new EventEmitter(); client.user = { id: botId, username: 'isolated-test-bot' };
  client.login = async () => { loggedIn++; client.emit(Events.ClientReady, client); };
  client.destroy = async () => { destroyed++; };
  const message = { id: '500000000000000009', guildId, channelId: env.SECURITY_SMOKE_LOG_CHANNEL_ID,
    edit: async payload => { writes.push(['edit', payload]); } };
  const channel = { id: message.channelId, guildId, type: ChannelType.GuildText, isTextBased: () => true, isThread: () => false,
    permissionsFor: () => ({ has: () => true }), send: async payload => { writes.push(['send', payload]); return message; } };
  const guild = { id: guildId, channels: { fetch: async () => channel }, members: { fetchMe: async () => ({ id: botId }) } };
  client.guilds = { fetch: async () => guild };
  const tokenEnv = { ...env, SECURITY_SMOKE_BOT_TOKEN: 'isolated-mock-token' };
  try {
    await assert.rejects(runSmoke({ env: tokenEnv, args: ['--connect-test-bot'], root,
      makeClient: () => client, identify: async () => ({ id: PRODUCTION_BOT_IDS[0], bot: true }) }), /ID_MISMATCH/);
    assert.equal(loggedIn, 0); assert.equal(writes.length, 0);
    await runSmoke({ env: tokenEnv, args: ['--connect-test-bot', '--post-synthetic'], root, makeClient: () => client,
      identify: async () => ({ id: botId, bot: true }), print: v => { outputs.push(v); if (v.ready) setImmediate(() => process.emit('SIGINT')); } });
    assert.equal(loggedIn, 1); assert.equal(writes.length, 2); assert.equal(destroyed, 2);
    assert.match(writes[0][1].embeds[0].data.title, /隔離テスト/);
    assert.doesNotMatch(writes[0][1].embeds[0].data.description, /送信されたよ/);
    assert.match(writes[1][1].embeds[0].data.description, /送信されたよ/);
    assert.equal(writes[0][1].components[0].toJSON().components.length, 2);
    const state = openSmokeState(smokeConfig(env), { root });
    try { assert.equal(state.incidents.snapshot(guildId, state.incidentId).log.payload.fingerprint, securityLogFingerprint(writes[1][1])); }
    finally { state.close(); }
    assert.ok(outputs.some(v => v.ready && v.timeoutCalls === 0 && v.commandsRegistered === 0));
    assert.doesNotMatch(JSON.stringify(outputs), /isolated-mock-token/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('test runner shutdown stops new clicks and drains in-flight reports before SQLite is closed', async () => {
  const f = evidenceFixture(); try {
    const emitter = new EventEmitter(); Object.assign(emitter, f.client);
    const config = smokeConfig({ ...env, SECURITY_REPORT_GUILD_ID: receiver.guildId, SECURITY_REPORT_CHANNEL_ID: receiver.channelId });
    let release; const wait = new Promise(resolve => { release = resolve; });
    const off = registerSmokeInteractions(emitter, config, { ...f, query: async () => ({ rows: [] }) }, {
      deliver: async (channel, payload) => { await wait; return channel.send(payload); },
    });
    const i = f.interaction('r'); i.isButton = () => true;
    const request = emitter.listeners(Events.InteractionCreate)[0](i);
    await new Promise(resolve => setImmediate(resolve));
    const drain = off(); let complete = false; void drain.then(() => { complete = true; });
    assert.equal(emitter.listenerCount(Events.InteractionCreate), 0);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
    release(); await request; await drain;
    assert.match(f.replies[0].content, /送信したよ/); assert.equal(f.sends.length, 1);
  } finally { f.storage.close(); }
});
