import assert from 'node:assert/strict';
import { MUTATE_OPERATOR_ROLE_SQL } from '../../lib/security-operators.mjs';
import { evidenceFixture } from './security-evidence-fixture.mjs';
import { guildId, roleId } from './security-operator-fixture.mjs';

// Runs inside the existing guarded, loopback-only PostgreSQL job after PR35's
// migration. Only the local test DB is touched; Discord calls remain Mocked.
export async function verifySecurityEvidence(client) {
  const query = (text, values) => client.query(text, values);
  await query(MUTATE_OPERATOR_ROLE_SQL, [guildId, roleId, true, 'phase-c-isolated']);
  const f = evidenceFixture({ kind: 'operator', query });
  try {
    await f.handler()(f.interaction());
    assert.ok(f.replies[0].files, 'registered operator can read persisted SQLite evidence');
    await query(MUTATE_OPERATOR_ROLE_SQL, [guildId, roleId, false, 'phase-c-isolated']);
    await f.handler()(f.interaction('r'));
    assert.match(f.replies[1].content, /運営権限/);
    assert.equal(f.sends.length, 0, 'revoked operator cannot send reports');
    await query('BEGIN');
    await query('ALTER TABLE guild_security_operator RENAME TO isolated_operator_unavailable');
    try {
      await f.handler()(f.interaction());
      assert.equal(f.replies[2].files, undefined, 'missing DB table fails closed');
      const owner = evidenceFixture({ kind: 'owner', query });
      try {
        await owner.handler()(owner.interaction('r'));
        assert.equal(owner.sends.length, 0, 'owner also denied during DB outage');
        assert.equal(owner.audit.getModerationAudit(`${owner.id}:report_claim`), null);
      } finally { owner.storage.close(); }
    } finally { await query('ROLLBACK'); }
    const other = '100000000000000002';
    assert.ok((await query('SELECT role_ids FROM guild_security_operator WHERE guild_id=$1', [other])).rows[0].role_ids.length > 0);
    await f.handler()(f.interaction('r'));
    assert.equal(f.sends.length, 0, 'other Guild operator rows grant no access');
  } finally { f.storage.close(); }
}
