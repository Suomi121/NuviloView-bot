import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { privateReportChannel } from '../lib/security-evidence-interactions.mjs';
import { authorizeSecurityOperator } from '../lib/security-operators.mjs';
import { evidenceFixture, botId, receiver } from './helpers/security-evidence-fixture.mjs';
import { roleId } from './helpers/security-operator-fixture.mjs';

const role = (id, admin = false) => ({ id, managed: false, tags: null,
  permissions: { has: p => admin && p === PermissionFlagsBits.Administrator } });
test('receiver Guild lookup is forced, current role result not stale manager cache', async () => {
  const f = evidenceFixture(); try {
    const calls = []; f.client.guilds.fetch = async options => { calls.push(options); return f.receiverGuild; };
    await privateReportChannel(f.client, receiver);
    assert.deepEqual(calls, [{ guild: receiver.guildId, force: true }]);
    f.receiverGuild.roles.cache.set(roleId, role(roleId)); // stale role deliberately left in cache
    f.receiverGuild.roles.fetch = async () => new Map();
    await assert.rejects(privateReportChannel(f.client, { ...receiver, roleIds: [roleId] }), /ROLE_INVALID/);
  } finally { f.storage.close(); }
});
test('unlisted Administrator role denies even without channel overwrite; explicit developer admin role is allowed', async () => {
  const f = evidenceFixture(); try {
    f.receiverGuild.roles.cache.set(roleId, role(roleId, true));
    await assert.rejects(privateReportChannel(f.client, receiver), /UNAPPROVED_ADMIN/);
    assert.equal(await privateReportChannel(f.client, { ...receiver, roleIds: [roleId] }), f.privateChannel);
  } finally { f.storage.close(); }
});
test('@everyone Administrator is never accepted, despite channel View deny', async () => {
  const f = evidenceFixture(); try {
    f.receiverGuild.roles.cache.set(receiver.guildId, role(receiver.guildId, true));
    await assert.rejects(privateReportChannel(f.client, receiver), /UNAPPROVED_ADMIN/);
    await assert.rejects(privateReportChannel(f.client, { ...receiver, roleIds: [receiver.guildId] }), /ROLE_INVALID/);
  } finally { f.storage.close(); }
});
test('only the current Bot managed admin role is exempt, never another Bot', async () => {
  const f = evidenceFixture(); try {
    const own = { ...role(roleId, true), managed: true, tags: { botId } };
    f.receiverGuild.roles.cache.set(roleId, own);
    f.receiverGuild.members.fetchMe = async () => ({ id: botId, roles: { cache: new Map([[roleId, own]]) } });
    f.privateChannel.permissionOverwrites.cache.set(roleId, { id: roleId, type: 0, allow: { has: () => true } });
    assert.equal(await privateReportChannel(f.client, receiver), f.privateChannel);
    own.tags.botId = '600000000000000002';
    await assert.rejects(privateReportChannel(f.client, receiver), /UNAPPROVED_ADMIN/);
  } finally { f.storage.close(); }
});
test('every receiver permission is checked again after permission changes', async () => {
  for (const missing of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]) {
    const f = evidenceFixture(); try {
      await privateReportChannel(f.client, receiver);
      f.privateChannel.permissionsFor = () => ({ has: permissions => !permissions.includes(missing) });
      await assert.rejects(privateReportChannel(f.client, receiver), /PERMISSION_DENIED/);
    } finally { f.storage.close(); }
  }
});
test('a role left in Guild manager cache but absent from fresh REST response cannot delegate', async () => {
  for (const kind of ['operator', 'admin']) {
  const f = evidenceFixture({ kind }); try {
    f.guild.roles.fetch = async () => new Map();
    assert.ok(f.guild.roles.cache.has(roleId));
    assert.equal(await authorizeSecurityOperator(f.interaction(), async () => ({ rows: [{ role_ids: [roleId] }] })), null);
    await f.handler()(f.interaction('r')); assert.equal(f.sends.length, 0); assert.equal(f.replies[0].files, undefined);
  } finally { f.storage.close(); }
  }
});
test('owner, approved developer role and Bot-specific member grants work; unrelated member grants deny', async () => {
  const f = evidenceFixture(); try {
    f.receiverGuild.roles.cache.set(roleId, role(roleId));
    const overwrites = f.privateChannel.permissionOverwrites.cache;
    for (const id of [botId, f.receiverGuild.ownerId]) overwrites.set(id, { id, type: 1, allow: { has: () => true } });
    overwrites.set(roleId, { id: roleId, type: 0, allow: { has: () => true } });
    assert.equal(await privateReportChannel(f.client, { ...receiver, roleIds: [roleId] }), f.privateChannel);
    overwrites.set('300000000000000008', { id: '300000000000000008', type: 1, allow: { has: () => true } });
    await assert.rejects(privateReportChannel(f.client, { ...receiver, roleIds: [roleId] }), /NOT_PRIVATE/);
  } finally { f.storage.close(); }
});
