import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers/coordinator-fixture.mjs';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { createShardStore,createDataPlane,SHARD_SCHEMA } from '../lib/multi-db/data-plane.mjs';
const guild='100000000000000001';
test('checkpoint, active-log compaction, restart, stale retry denial and encrypted audit archive',async t=>{
 const f=fixture(t),key=randomBytes(32);f.dbs.forEach(db=>db.exec(SHARD_SCHEMA));
 const stores=['neon','supabase','turso'].map((id,i)=>createShardStore({id,dialect:'sqlite',execute:async(q,p)=>f.dbs[i].prepare(q).all(...p)}));
 const coordinator=()=>createCoordinator({providers:f.providers,epoch:'isolated-test-v1',checkpointing:true,maxSlots:12});
 const c=coordinator(),archive=createDataPlane({coordinator:c,stores});let state={checksum:'GENESIS',value:{revision:0}};
 for(let i=0;i<30;i++){
   if(i>0&&i%8===0)await c.checkpoint({guildId:guild,archive,key,keyId:'isolated-key',actorId:'isolated',requestId:`cp:${i}`});
   state=await c.update({guildId:guild,expectedRevision:state.value.revision,expectedChecksum:state.checksum,requestId:`write:${i}`,actorId:'isolated',action:'test',data:{strength:i}});
 }
 assert.equal((await coordinator().read(guild)).value.data.strength,29);
 await assert.rejects(c.update({guildId:guild,expectedRevision:0,expectedChecksum:'GENESIS',requestId:'write:0',actorId:'isolated',action:'test',data:{strength:0}}),{code:'MDB_CHECKPOINT_STALE'});
 assert.equal(f.dbs[0].prepare('SELECT count(*) n FROM mdb_acceptor WHERE guild_id=?').get(guild).n,31,'permanent promises retained, no destructive GC');
 assert.equal((await c.recover(guild)).history.length,7,'bounded active prefix after CP');
 f.faults.neon='offline';assert.equal((await coordinator().read(guild)).value.revision,30);
 f.faults.turso='offline';await assert.rejects(coordinator().read(guild));
});
test('failed archive quorum never publishes a checkpoint; old history remains readable',async t=>{
 const f=fixture(t),c=createCoordinator({providers:f.providers,epoch:'isolated-test-v1',checkpointing:true});
 await c.update({guildId:guild,expectedRevision:0,expectedChecksum:'GENESIS',requestId:'first',actorId:'isolated',action:'test',data:{a:1}});
 await assert.rejects(c.checkpoint({guildId:guild,archive:{save:async()=>{throw Error('offline');}},key:randomBytes(32),keyId:'isolated',actorId:'isolated',requestId:'bad'}));
 assert.equal((await c.read(guild)).value.revision,1);
});
test('crash after archive persistence resumes the same immutable archive despite new recovery ballots',async t=>{
 const f=fixture(t),key=randomBytes(32);f.dbs.forEach(db=>db.exec(SHARD_SCHEMA));
 const stores=['neon','supabase','turso'].map((id,i)=>createShardStore({id,dialect:'sqlite',execute:async(q,p)=>f.dbs[i].prepare(q).all(...p)}));
 const c=createCoordinator({providers:f.providers,epoch:'isolated-test-v1',checkpointing:true}),archive=createDataPlane({coordinator:c,stores});
 await c.update({guildId:guild,expectedRevision:0,expectedChecksum:'GENESIS',actorId:'isolated',requestId:'one',action:'test',data:{a:1}});
 let once=true;const interrupted={...archive,read:async args=>{if(once){once=false;throw Error('PROCESS_INTERRUPTED');}return archive.read(args);}};
 const args={guildId:guild,archive:interrupted,key,keyId:'fixture-key',actorId:'isolated',requestId:'recover-cp'};
 await assert.rejects(c.checkpoint(args));assert.equal((await c.checkpoint(args)).value.data.base.value.revision,1);
});
