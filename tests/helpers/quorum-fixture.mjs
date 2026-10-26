import { DatabaseSync } from 'node:sqlite';
import { createCoordinator } from '../../lib/multi-db/coordinator.mjs';
import { createSqlAcceptor, ACCEPTOR_SCHEMA } from '../../lib/multi-db/acceptor.mjs';
import { createSecurityService, initialSecuritySnapshot } from '../../lib/multi-db/security-service.mjs';
export const guild = '100000000000000001';
export const actor = '100000000000000003';
export async function securityFixture(t) {
  const dbs = [], faults = {};
  const providers = ['neon', 'supabase', 'turso'].map(id => {
    const db = new DatabaseSync(':memory:'); db.exec(ACCEPTOR_SCHEMA); dbs.push(db);
    return createSqlAcceptor({ id, dialect: 'sqlite', execute: async (sql, args) => {
      if (faults[id]) throw new Error('isolated offline');
      return db.prepare(sql).all(...args);
    } });
  });
  const coordinator = createCoordinator({ providers, epoch: 'fixture-epoch' });
  for (const [i, db] of dbs.entries()) db.prepare('INSERT INTO mdb_membership VALUES(1,?,?)').run(coordinator.membership, providers[i].id);
  t.after(() => dbs.forEach(db => db.close()));
  const security = createSecurityService(coordinator);
  await security.importFenced({ guildId: guild, actorId: actor, requestId: 'import', snapshot: initialSecuritySnapshot(), verifyFence: async () => true });
  async function change(operation, value = null, authorize = async () => true) {
    const state = await security.read(guild);
    return security.change({ guildId: guild, actorId: actor, requestId: `fixture:${operation}:${state.value.revision}`,
      expectedRevision: state.value.revision, expectedChecksum: state.checksum, operation, value, authorize });
  }
  return { security, coordinator, providers, dbs, faults, change };
}
