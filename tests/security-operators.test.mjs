import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeSecurityOperator, createOperatorRoleHandler, createInteractionLimiter, operatorRoleCommand } from '../lib/security-operators.mjs';
import { operatorFixture, roleId } from './helpers/security-operator-fixture.mjs';
for (const [kind, expected] of [['owner', true], ['admin', true], ['operator', true], ['member', false], ['manage', false]]) {
  test(`fresh operator authorization: ${kind}`, async () => {
    const f = operatorFixture({ kind });
    assert.equal(Boolean(await authorizeSecurityOperator(f.interaction, async () => ({ rows: [{ role_ids: [roleId] }] }))), expected);
    assert.ok(f.calls.some(value => value?.force === true)); assert.ok(f.calls.includes('roles'));
  });
  test(`operator configuration: ${kind}`, async () => {
    const f = operatorFixture({ kind }); let writes = 0;
    await createOperatorRoleHandler({ query: async () => { writes++; return { rows: [{ role_ids: [roleId] }] }; } })(f.interaction);
    assert.equal(writes, ['owner', 'admin'].includes(kind) ? 1 : 0);
  });
}
test('revoked/deleted role, wrong Guild and DB failure deny delegated authority', async () => {
  for (const change of [f => f.member.roles.cache.clear(), f => f.guild.roles.cache.clear(), f => { f.guild.id = 'other'; }, f => { f.role.managed = true; }, f => { f.role.tags = { integrationId: 'integration' }; }]) {
    const f = operatorFixture({ kind: 'operator' }); change(f);
    assert.equal(await authorizeSecurityOperator(f.interaction, async () => ({ rows: [{ role_ids: [roleId] }] })), null);
  }
  assert.equal(await authorizeSecurityOperator(operatorFixture({ kind: 'operator' }).interaction, async () => { throw new Error('DB'); }), null);
});
test('invalid role choices cannot be registered', async () => {
  for (const change of [f => { f.role.managed = true; }, f => { f.role.tags = { botId: 'bot' }; }, f => { f.role.id = f.guild.id; }, f => f.guild.roles.cache.clear(), f => { f.role.guild = { id: 'other' }; }, f => { f.member.roles.highest.comparePositionTo = () => 0; }]) {
    const f = operatorFixture({ kind: 'admin' }); change(f);
    await createOperatorRoleHandler({ query: async () => { assert.fail('No writes allowed'); } })(f.interaction);
    assert.doesNotMatch(f.replies[0].content, /登録したよ/);
  }
});
test('list/remove respond only after successful storage; safe mentions and rate bound', async () => {
  for (const operation of ['list', 'status', 'remove']) {
    const f = operatorFixture({ kind: 'owner' }); f.interaction.options.getSubcommand = () => operation;
    await createOperatorRoleHandler({ query: async () => ({ rows: [{ role_ids: [roleId] }] }) })(f.interaction);
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
  }
  const f = operatorFixture({ kind: 'admin' });
  await createOperatorRoleHandler({ query: async () => { throw new Error('secret'); } })(f.interaction);
  assert.doesNotMatch(f.replies[0].content, /secret|登録したよ/);
  const allow = createInteractionLimiter({ maxEntries: 1 }); assert.equal(allow('a'), true); assert.equal(allow('a'), false); assert.equal(allow('b'), false);
  assert.deepEqual(operatorRoleCommand.options.map(option => option.name), ['add', 'remove', 'list', 'status']);
});
