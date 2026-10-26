import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { isolatedTursoHttp } from './helpers/isolated-turso-http.mjs';
import { recoveryPlan,recoveryEvidence,recoveryGuild as guildId } from './helpers/recovery-fixture.mjs';
import { recoveryPrefix,recoverySchema,bootstrapUnconfirmedRecovery,validateRecoveryPlan } from '../lib/multi-db/recovery-bootstrap.mjs';
import { createSqlAcceptor } from '../lib/multi-db/acceptor.mjs';
import { createDataPlane,createShardStore } from '../lib/multi-db/data-plane.mjs';
import { createApplicationStore } from '../lib/multi-db/application-store.mjs';
import { checksum,createCoordinator } from '../lib/multi-db/coordinator.mjs';

test('real isolated PostgreSQL + Turso SDK: application data survives Neon outage, repair, restart and conflicting writers',{skip:!process.env.TEST_COORDINATOR_DATABASE_URL},async t=>{
  const url=new URL(process.env.TEST_COORDINATOR_DATABASE_URL);
  assert.equal(process.env.TEST_COORDINATOR_ISOLATED,'1');assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/nuviloview_quorum_test');
  const pg=new Client({connectionString:url.href}),neon=new Client({connectionString:url.href});await pg.connect();await neon.connect();t.after(async()=>{await pg.end();await neon.end();});
  await pg.query('CREATE SCHEMA application_test; SET search_path=application_test');await neon.query('CREATE SCHEMA application_neon_test; SET search_path=application_neon_test');
  const plan={...recoveryPlan(),epoch:'isolated-application-20261026'};plan.schemaChecksum=checksum(recoverySchema(plan.epoch));const prefix=recoveryPrefix(plan.epoch);
  const turso=await isolatedTursoHttp(t);await pg.query(recoverySchema(plan.epoch));await neon.query(recoverySchema(plan.epoch));await turso.client.executeMultiple(recoverySchema(plan.epoch));
  let neonOnline=false,pgOnline=true;
  const execute={neon:async(s,a)=>{if(!neonOnline)throw Error('ISOLATED_NEON_OFFLINE');return neon.query(s,a);},supabase:async(s,a)=>{if(!pgOnline)throw Error('ISOLATED_SUPABASE_OFFLINE');return pg.query(s,a);},turso:(sql,args)=>turso.client.execute({sql,args})};
  const providers=['neon','supabase','turso'].map(id=>createSqlAcceptor({id,dialect:id==='turso'?'sqlite':'postgres',execute:execute[id],tablePrefix:prefix}));
  const r=await bootstrapUnconfirmedRecovery({providers,plan,evidence:recoveryEvidence(plan),approval:validateRecoveryPlan(plan)});
  const stores=['neon','supabase','turso'].map(id=>createShardStore({id,dialect:id==='turso'?'sqlite':'postgres',execute:execute[id],tablePrefix:prefix}));
  const make=()=>{const coordinator=createCoordinator({providers,epoch:plan.epoch});return createApplicationStore({coordinator,dataPlane:createDataPlane({coordinator,stores}),authorize:async()=>true,key:Buffer.alloc(32,7),keyId:'isolated-test-key'});};
  const s=make(),input={domain:'goals',guildId,ownerId:'fixture-user',actorId:'fixture-user'},data={goals:[{type:'messages',target:1300}]};
  const saved=await s.write({...input,expectedEpoch:plan.epoch,expectedRevision:0,expectedChecksum:'GENESIS',acknowledgeUnconfirmed:true,requestId:'goals-on-two-real-databases',data});
  assert.deepEqual((await make().read(input)).data,data);
  turso.setOffline(true);await assert.rejects(s.read(input));turso.setOffline(false);
  assert.equal((await s.read(input)).checksum,saved.checksum);
  // Only now initialize the third (new-epoch) voter and recover its state.
  neonOnline=true;await providers[0].initializeMembership(r.coordinator.membership);await s.read(input);assert.equal((await s.repair(input)).complete,true);
  pgOnline=false;assert.deepEqual((await s.read(input)).data,data);pgOnline=true;
  // Leave an unencrypted artifact on BOTH real PostgreSQL stores for the
  // separate actual server-restart/backup-restore verification in CI.
  const p={domain:'guild-settings',guildId,actorId:'fixture-admin'};
  await s.write({...p,expectedEpoch:plan.epoch,expectedRevision:0,expectedChecksum:'GENESIS',acknowledgeUnconfirmed:true,requestId:'persistent-guild-settings',data:{testMarker:'new-epoch-value'}});
  await s.repair(p);
  const snapshot=await s.read(p);
  const attempts=await Promise.allSettled(['a','b'].map(requestId=>make().write({...p,expectedEpoch:plan.epoch,expectedRevision:snapshot.revision,expectedChecksum:snapshot.checksum,requestId,data:{testMarker:requestId}})));
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
});
