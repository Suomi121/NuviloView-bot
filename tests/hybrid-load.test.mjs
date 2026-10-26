import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers/coordinator-fixture.mjs';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { createDataPlane,createShardStore,SHARD_SCHEMA } from '../lib/multi-db/data-plane.mjs';
test('bounded multi-Guild/revision load, checkpoint restart and Neon outage',async t=>{
 const f=fixture(t),heavy=process.env.HYBRID_STRESS==='1',guildCount=heavy?100:4,revisions=heavy?160:20,key=randomBytes(32);
 f.dbs.forEach(db=>db.exec(SHARD_SCHEMA));
 const stores=['neon','supabase','turso'].map((id,i)=>createShardStore({id,dialect:'sqlite',execute:async(q,p)=>{if(f.faults[id])throw Error('OFFLINE');return f.dbs[i].prepare(q).all(...p);}}));
 const c=createCoordinator({providers:f.providers,epoch:'isolated-test-v1',checkpointing:true,maxSlots:40}),archive=createDataPlane({coordinator:c,stores});
 const begin=performance.now();let updates=0,checkpoints=0;
 for(let g=0;g<guildCount;g++){
  const guildId=String(100000000000000100n+BigInt(g));let state={value:{revision:0},checksum:'GENESIS'};
  f.faults.neon=g%2?'offline':null;
  for(let i=0;i<revisions;i++){
   if(i>0&&i%32===0){await c.checkpoint({guildId,archive,key,keyId:'stress-fixture',actorId:'isolated',requestId:`cp:${i}`});checkpoints++;}
   state=await c.update({guildId,expectedRevision:state.value.revision,expectedChecksum:state.checksum,actorId:'isolated',action:'test',requestId:`write:${i}`,data:{strength:i%100,autoTimeout:false}});updates++;
  }
  assert.equal((await c.read(guildId)).checksum,state.checksum);
 }
 f.faults.neon=null;
 const restarted=createCoordinator({providers:f.providers,epoch:'isolated-test-v1',checkpointing:true,maxSlots:40});
 for(let g=0;g<guildCount;g++)assert.equal((await restarted.read(String(100000000000000100n+BigInt(g)))).value.revision,revisions);
 t.diagnostic(JSON.stringify({guildCount,revisions,updates,checkpoints,elapsedMs:Math.round(performance.now()-begin),testType:'bounded-isolated-not-production-soak'}));
});
