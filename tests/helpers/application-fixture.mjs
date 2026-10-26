import { recoveryFixture, recoveryGuild } from './recovery-fixture.mjs';
import { createShardStore, createDataPlane } from '../../lib/multi-db/data-plane.mjs';
import { recoveryPrefix } from '../../lib/multi-db/recovery-bootstrap.mjs';
import { createApplicationStore } from '../../lib/multi-db/application-store.mjs';
export async function applicationFixture(t) {
  const f = await recoveryFixture(t);
  const stores = f.dbs.map((db,i) => createShardStore({ id: ['neon','supabase','turso'][i], dialect: 'sqlite', tablePrefix: recoveryPrefix(f.plan.epoch), execute: async (sql,args) => {
    if (f.faults[['neon','supabase','turso'][i]]) throw Error('ISOLATED_OFFLINE');
    return db.prepare(sql).all(...args);
  } }));
  const dataPlane = createDataPlane({ coordinator: f.coordinator, stores });
  const store = createApplicationStore({ coordinator: f.coordinator, dataPlane, key: Buffer.alloc(32,7), keyId: 'isolated-test-key',
    authorize: async ({ guildId, actorId, ownerId }) => guildId === recoveryGuild || guildId === f.plan.controlId ? actorId !== 'denied' && (!ownerId || ownerId === actorId) : false });
  const save = async (domain,data,{ownerId='',actorId=ownerId||'isolated-bot',...extra}={}) => {
    const old = await store.read({ domain,guildId: recoveryGuild,ownerId,actorId });
    return store.write({ domain,guildId: recoveryGuild,ownerId,actorId,expectedEpoch:old.epoch,expectedRevision:old.revision,expectedChecksum:old.checksum,
      acknowledgeUnconfirmed:true,requestId:`isolated-${domain}-${old.revision+1}`,data,...extra });
  };
  return { ...f, stores, dataPlane, store, save };
}
