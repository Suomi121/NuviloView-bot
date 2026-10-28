import test from 'node:test';import assert from 'node:assert/strict';import {Client} from 'pg';
import {createSqlAcceptor} from '../lib/multi-db/acceptor.mjs';import {createCoordinator} from '../lib/multi-db/coordinator.mjs';
import {createShardStore,createDataPlane} from '../lib/multi-db/data-plane.mjs';import {createApplicationStore} from '../lib/multi-db/application-store.mjs';
import {recoveryPrefix} from '../lib/multi-db/recovery-bootstrap.mjs';import {recoveryGuild as guildId} from './helpers/recovery-fixture.mjs';
test('actual PostgreSQL restart retains application manifest, encrypted goals and fresh replacement value',{skip:process.env.TEST_HYBRID_RESTART!=='1'},async t=>{
 const url=new URL(process.env.TEST_COORDINATOR_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/nuviloview_quorum_test');
 const clients=[];const epoch='isolated-application-20261026',prefix=recoveryPrefix(epoch),execute={turso:async()=>{throw Error('TURSO_OFFLINE_FOR_RESTART_PROOF');}};
 for(const [id,schema] of [['neon','application_neon_test'],['supabase','application_test']]){const c=new Client({connectionString:url.href});await c.connect();clients.push(c);await c.query('SET search_path='+schema);execute[id]=(s,a)=>c.query(s,a);}
 t.after(async()=>{await Promise.all(clients.map(c=>c.end()));});
 const providers=['neon','supabase','turso'].map(id=>createSqlAcceptor({id,dialect:id==='turso'?'sqlite':'postgres',tablePrefix:prefix,execute:execute[id]}));
 const stores=['neon','supabase','turso'].map(id=>createShardStore({id,dialect:id==='turso'?'sqlite':'postgres',tablePrefix:prefix,execute:execute[id]}));
 const c=createCoordinator({providers,epoch}),store=createApplicationStore({coordinator:c,dataPlane:createDataPlane({coordinator:c,stores}),authorize:async()=>true,key:Buffer.alloc(32,7),keyId:'isolated-test-key'});
 const record=await store.read({domain:'guild-settings',guildId,actorId:'restart-test'});assert.ok(['a','b'].includes(record.data.testMarker));
 assert.equal((await store.read({domain:'goals',guildId,ownerId:'fixture-user',actorId:'fixture-user'})).data.goals[0].target,1300);
});
