import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MUTATE_OPERATOR_ROLE_SQL, readOperatorRoles } from '../../lib/security-operators.mjs';
export async function verifyOperatorRoles(client) {
  const query = (text, values) => client.query(text, values);
  await query(readFileSync(new URL('../../scripts/migrations/20261017-security-operator-roles.sql', import.meta.url), 'utf8'));
  const a = '100000000000000001', b = '100000000000000002', role = '200000000000000001';
  await query(MUTATE_OPERATOR_ROLE_SQL, [a, role, true, 'actor']);
  await query(MUTATE_OPERATOR_ROLE_SQL, [a, role, true, 'actor']);
  assert.deepEqual(await readOperatorRoles(query, a), [role]); assert.deepEqual(await readOperatorRoles(query, b), []);
  await query(MUTATE_OPERATOR_ROLE_SQL, [a, role, false, 'actor']);
  assert.deepEqual(await readOperatorRoles(query, a), []);
  assert.equal((await query('SELECT count(*)::int n FROM guild_security_operator_audit WHERE guild_id=$1', [a])).rows[0].n, 3);
  await query('BEGIN');
  await query("ALTER TABLE guild_security_operator_audit ADD CONSTRAINT isolated_fail CHECK (actor_id <> 'fail')");
  await assert.rejects(query(MUTATE_OPERATOR_ROLE_SQL, [a, role, true, 'fail'])); await query('ROLLBACK');
  assert.deepEqual(await readOperatorRoles(query, a), []);
}
