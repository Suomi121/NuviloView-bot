import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {createRequire} from 'node:module';
import {applicationFixture} from './helpers/application-fixture.mjs';
import {readApplicationRuntime} from '../lib/multi-db/application-runtime-read.mjs';
import {createApplicationProjectionRouter} from '../lib/multi-db/application-projection.mjs';
const now=1800000000000,require=createRequire(import.meta.url);
async function runtimeFixture(t) {
 const f=await applicationFixture(t),controlId=f.plan.controlId;
 await f.coordinator.scoped('runtime-owner').update({guildId:controlId,actorId:'approved-test',requestId:'owner-init',expectedRevision:0,expectedChecksum:'GENESIS',action:'runtime:initialize',data:{owner:{instanceId:'test-instance',hostId:'test-host'},generation:1}});
 const snapshot=(snapshotType,payload)=>({snapshotType,aggregateId:snapshotType==='runtime'?'nuviloview-bot':'nuviloview-sync',snapshotVersion:1,generatedAt:now-1000,checksum:'fixture',payload});
 const data={runtime:snapshot('runtime',{botInstanceId:'test-instance',botHostId:'test-host',botStatus:'RUNNING',botHeartbeatAt:now-2000,workerStatus:'RUNNING',workerHeartbeatAt:now-1000,sqliteStatus:'HEALTHY',botGuildCount:17}),sync_status:snapshot('sync_status',{providers:['supabase','turso'].map(providerId=>({providerId,required:true,enabled:true,status:'HEALTHY',circuit:'CLOSED',pending:0,retry:0,deadLetter:0,lastSuccessAt:now-1000}))})};
 let n=0;const save=async()=>{const input={domain:'runtime',guildId:controlId,actorId:'isolated-observer'},old=await f.store.read(input);return f.store.write({...input,expectedEpoch:old.epoch,expectedRevision:old.revision,expectedChecksum:old.checksum,acknowledgeUnconfirmed:true,requestId:'runtime-'+(++n),data});};
 await save();const router=createApplicationProjectionRouter({store:f.store,actorId:'runtime-observer',controlId,now:()=>now});
 const read=()=>readApplicationRuntime({coordinator:f.coordinator,controlId,now,readProjection:()=>Promise.all([router.readRuntimeSnapshot(),router.readSyncStatusSnapshot()])});
 return{...f,controlId,data,save,read};
}
test('Neon-free runtime observation requires matched actual owner/heartbeat and does not invent a TTL lease',async t=>{
 const f=await runtimeFixture(t);const r=await f.read();assert.equal(r.diagnostic.state,'Healthy');assert.equal(r.authority,'cloud-quorum');assert.equal(r.lease.leaseExpiresAt,null);assert.equal(r.dbNow,null);assert.equal(r.heartbeats[0].instanceId,'test-instance');
 assert.equal(r.heartbeats[0].appVersion,'UNKNOWN');assert.equal(r.heartbeats[0].startedAt,null);
 f.data.runtime.payload.botInstanceId='old-instance';await f.save();const unknown=await f.read();assert.equal(unknown.diagnostic.state,'Unknown');assert.deepEqual(unknown.heartbeats,[]);
});
test('runtime reports stale Worker and lost quorum rather than treating a cached owner as healthy',async t=>{
 const f=await runtimeFixture(t);f.data.runtime.payload.workerHeartbeatAt=now-1000000;await f.save();assert.equal((await f.read()).diagnostic.state,'Critical');
 f.faults.supabase=true;await assert.rejects(f.read());
});
test('actual developer runtime endpoints preserve authorization and never open legacy Neon in quorum mode',async t=>{
 const f=await runtimeFixture(t),old=process.env.APPLICATION_DATA_MODE;process.env.APPLICATION_DATA_MODE='quorum';t.after(()=>{if(old===undefined)delete process.env.APPLICATION_DATA_MODE;else process.env.APPLICATION_DATA_MODE=old;});
 for(const resource of ['lease','heartbeats'])for(const allowed of [false,true]){
  const source=fs.readFileSync(new URL(`../app/api/developer/runtime/${resource}/route.ts`,import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,mod={exports:{}};
  const mocks={'@/lib/developer-access':{getDeveloperAccess:async()=>allowed?{userId:'developer-user'}:null},'@/lib/db':{pool:{query:()=>{throw Error('NEON_MUST_NOT_OPEN');},connect:()=>{throw Error('NEON_MUST_NOT_OPEN');}}},'@/lib/request-security':{isRateLimited:async()=>false},'@/lib/runtime-monitor.mjs':{},'@/lib/multi-db/application-runtime-web':{readApplicationRuntimeForWeb:f.read}};
  new Function('require','module','exports',js)(id=>id in mocks?mocks[id]:require(id),mod,mod.exports);
  const response=await mod.exports.GET(new Request('https://isolated.invalid/api/developer/runtime/'+resource));assert.equal(response.status,allowed?200:403);
 }
});
