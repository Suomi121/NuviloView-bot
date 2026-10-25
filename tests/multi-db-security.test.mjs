import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { securityFixture, guild, actor } from './helpers/quorum-fixture.mjs';
import { createSecurityService } from '../lib/multi-db/security-service.mjs';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { handleQuorumSpamCommand } from '../lib/multi-db/discord-spam.mjs';

test('consent OFF persists across level updates and restart; ON is explicit and revocable', async t => {
  const f = await securityFixture(t);
  assert.equal(await f.security.automaticAllowed(guild, { emergencyStop: false }), false);
  await f.change('level', 81);
  assert.equal((await f.security.read(guild)).value.data.autoTimeout, false);
  await f.change('auto:on');
  assert.equal(await f.security.automaticAllowed(guild, { emergencyStop: false }), true);
  const freshPolicy = (await f.security.read(guild)).value.data.policy;
  await f.change('level', 12);
  assert.equal(await f.security.automaticAllowed(guild, { emergencyStop: false, expectedPolicy: freshPolicy }), false);
  await f.change('auto:off');
  const restart = createSecurityService(createCoordinator({ providers: f.providers, epoch: 'fixture-epoch' }));
  assert.equal((await restart.read(guild)).value.data.autoTimeout, false);
});

test('emergency stop, missing Guild and DB outage deny punishment; safe single-store outage does not disable explicit consent forever', async t => {
  const f = await securityFixture(t);
  await f.change('auto:on');
  await f.change('emergency:on');
  assert.equal(await f.security.automaticAllowed(guild, { emergencyStop: false }), false);
  await f.change('emergency:off');
  assert.equal(await f.security.automaticAllowed(guild), false, 'runtime emergency defaults ON');
  assert.equal(await f.security.automaticAllowed('100000000000000002', { emergencyStop: false }), false);
  f.faults.neon = true;
  assert.equal(await f.security.automaticAllowed(guild, { emergencyStop: false }), true);
  f.faults.supabase = true;
  assert.equal(await f.security.automaticAllowed(guild, { emergencyStop: false }), false);
});

test('operator roles / log routing have independent fields and immutable consensus audit; forbidden and reset never mutate', async t => {
  const f = await securityFixture(t);
  const initial = await f.security.read(guild);
  await assert.rejects(f.change('operator:add', actor, async () => false), { code: 'MDB_FORBIDDEN' });
  assert.equal((await f.security.read(guild)).checksum, initial.checksum);
  await f.change('operator:add', actor);
  await f.change('log:set', '100000000000000004');
  await f.change('log:off');
  const state = (await f.security.read(guild)).value;
  assert.deepEqual(state.data.operatorRoleIds, [actor]);
  assert.equal(state.data.logChannelId, null);
  assert.equal(state.data.autoTimeout, false);
  await assert.rejects(f.change('reset'), { code: 'MDB_OPERATION_DENIED' });
  assert.equal((await f.coordinator.recover(guild)).history.length, 4);
});

test('quorum Discord path ACKs before unresolved DB/fresh permission work; no duplicated response or raw errors', async () => {
  const calls = []; let release;
  const permission = new Promise(resolve => { release = resolve; });
  const i = { guildId: guild, user: { id: actor }, id: '100000000000000006',
    inGuild: () => true, guild: { fetch: async () => { calls.push('fresh'); await permission; throw new Error('SECRET'); } },
    deferReply: async () => { calls.push('ACK'); i.deferred = true; },
    editReply: async p => { calls.push('EDIT'); assert.doesNotMatch(p.content, /SECRET/); } };
  const run = handleQuorumSpamCommand(i, { read: async () => { throw new Error('no unauthorized read'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['ACK', 'fresh']);
  release(); await run;
  assert.deepEqual(calls, ['ACK', 'fresh', 'EDIT']);
});

test('quorum Discord path denies Manage Guild lost at write, and never reads other Guild', async t => {
  const f = await securityFixture(t); let reads = 0, grants = 0;
  const g = { id: guild, ownerId: '100000000000000099', roles: { fetch: async () => new Map() },
    members: { fetch: async () => ({ id: actor, guild: g, permissions: { has: p => p === PermissionFlagsBits.ManageGuild && ++grants === 1 } }) } };
  g.fetch = async () => g;
  const replies = [];
  const i = { guildId: guild, guild: g, user: { id: actor }, id: '100000000000000006', inGuild: () => true,
    options: { getSubcommand: () => 'level', getSubcommandGroup: () => null, getInteger: () => 88 },
    deferReply: async () => { i.deferred = true; }, editReply: async p => replies.push(p.content) };
  await handleQuorumSpamCommand(i, { ...f.security, read: async id => { assert.equal(id, guild); reads++; return f.security.read(id); } });
  assert.equal(reads, 1);
  assert.match(replies[0], /権限/);
  assert.equal((await f.security.read(guild)).value.revision, 1);
});
