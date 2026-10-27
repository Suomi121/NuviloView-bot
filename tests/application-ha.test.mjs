import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { createApplicationStore, applicationArtifact } from '../lib/multi-db/application-store.mjs';
import { createDataPlane } from '../lib/multi-db/data-plane.mjs';
import { applicationFixture } from './helpers/application-fixture.mjs';
import { recoveryGuild as guildId } from './helpers/recovery-fixture.mjs';
import { appendApplicationAlert } from '../lib/multi-db/application-alerts.mjs';
import { readApplicationNotifications, dismissApplicationNotification } from '../lib/multi-db/notifications.mjs';
import { createApplicationProjectionRouter, publishApplicationProjection } from '../lib/multi-db/application-projection.mjs';
import { quorumRateLimited } from '../lib/multi-db/quorum-rate-limit.mjs';
import { createApplicationRepairer } from '../lib/multi-db/application-repair.mjs';
import { createApplicationPublisher } from '../lib/multi-db/application-worker.mjs';
import { submitApplicationSupport } from '../lib/multi-db/application-support.mjs';
const user = 'isolated-user';
const goals = { goals: [{ type: 'messages', target: 1200 }] };

test('Neon offline: goals are unconfirmed, explicit CAS save and fresh reread work on two voters',async t => {
  const f=await applicationFixture(t),input={guildId,domain:'goals',ownerId:user,actorId:user};
  const old=await f.store.read(input);assert.equal(old.state,'unconfirmed');assert.equal(old.data,null);
  await assert.rejects(f.store.write({...input,expectedEpoch:old.epoch,expectedRevision:0,expectedChecksum:'GENESIS',data:goals,requestId:'no-confirm'}),{code:'APP_CONFIRMATION_REQUIRED'});
  const saved=await f.save('goals',goals,{ownerId:user});assert.equal(saved.revision,1);
  assert.deepEqual((await f.store.read(input)).data,goals);
  assert.equal(await f.security.automaticAllowed(guildId,{emergencyStop:false}),false);
});
test('application CAS rejects old epoch, stale concurrent writes and cross Guild/owner access',async t => {
  const f=await applicationFixture(t),input={domain:'goals',guildId,ownerId:user,actorId:user,expectedEpoch:f.plan.epoch,expectedRevision:0,expectedChecksum:'GENESIS',acknowledgeUnconfirmed:true,data:goals};
  await assert.rejects(f.store.write({...input,requestId:'wrong-epoch',expectedEpoch:'retired'}),{code:'MDB_EPOCH_CONFLICT'});
  const results=await Promise.allSettled(['first','second'].map(requestId=>f.store.write({...input,requestId})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(f.store.read({...input,guildId:'100000000000000099'}),{code:'APP_FORBIDDEN'});
  await assert.rejects(f.store.read({...input,actorId:'other'}),{code:'APP_FORBIDDEN'});
});
test('private application state requires encryption and does not leak into shards',async t=>{
  const f=await applicationFixture(t);await f.save('goals',goals,{ownerId:user});
  for(const db of f.dbs){const rows=db.prepare("SELECT payload FROM "+f.tablePrefix+"mdb_blob_shard").all();for(const row of rows)assert.ok(!Buffer.from(row.payload,'base64').includes(Buffer.from('isolated-user')));}
  const unsafe=createApplicationStore({coordinator:f.coordinator,dataPlane:f.dataPlane,authorize:async()=>true});
  await assert.rejects(unsafe.read({domain:'goals',guildId,ownerId:user,actorId:user}),{code:'APP_ENCRYPTION_REQUIRED'});
});
test('lost quorum refuses reads/writes, recovery and new process retain chosen application state',async t=>{
  const f=await applicationFixture(t);await f.save('goals',goals,{ownerId:user});f.faults.supabase=true;
  await assert.rejects(f.store.read({domain:'goals',guildId,ownerId:user,actorId:user}));f.faults.supabase=false;
  const c=createCoordinator({providers:f.providers,epoch:f.plan.epoch});const s=createApplicationStore({coordinator:c,dataPlane:createDataPlane({coordinator:c,stores:f.stores}),key:Buffer.alloc(32,7),keyId:'isolated-test-key',authorize:async()=>true});
  assert.deepEqual((await s.read({domain:'goals',guildId,ownerId:user,actorId:user})).data,goals);
});
test('shard repair restores a missing shard without changing manifest; no two shards means unavailable',async t=>{
  const f=await applicationFixture(t);await f.save('goals',goals,{ownerId:user});
  const input={domain:'goals',guildId,ownerId:user,actorId:user};const old=await f.store.read(input);
  f.faults.neon=false;
  const fixed=await f.store.repair(input);assert.equal(fixed.complete,true);assert.equal((await f.store.read(input)).checksum,old.checksum);
  f.faults.neon=true;f.dbs[2].prepare(`DELETE FROM ${f.tablePrefix}mdb_blob_shard`).run();
  await assert.rejects(f.store.read(input));
});
test('notifications: same confirmed alerts across Bot/Web, authorized fanout, dismiss persists without Auth foreign key',async t=>{
  const f=await applicationFixture(t);
  const a={store:f.store,guildId,actorId:'isolated-bot',type:'offline',title:'架空の通知',body:'合成データ',proveOwner:async()=>true,now:Date.now()};
  await appendApplicationAlert(a);assert.equal((await appendApplicationAlert(a)).duplicate,true);
  let read=await readApplicationNotifications({store:f.store,userId:user,guildIds:[guildId]});assert.equal(read.notifications.length,1);assert.equal(read.states[0].historyCoverage,'since_epoch');
  const n=read.notifications[0];await dismissApplicationNotification({store:f.store,userId:user,guildId,id:n.id,token:n.token,requestId:'dismiss-1'});
  read=await readApplicationNotifications({store:f.store,userId:user,guildIds:[guildId]});assert.equal(read.notifications.length,0);
  await assert.rejects(appendApplicationAlert({...a,type:'no-owner',proveOwner:async()=>false}),{code:'APP_PUBLISHER_FENCED'});
  await assert.rejects(dismissApplicationNotification({store:f.store,userId:user,guildId,id:'f'.repeat(32),token:n.token,requestId:'forged'}),{code:'APP_FORBIDDEN'});
});
test('analytics: fenced publisher, source watermark and quorum pointer prevent stale Neon overwrite',async t=>{
  const f=await applicationFixture(t),id=f.plan.controlId;
  await f.coordinator.scoped('application-publisher').update({guildId:id,actorId:'approved-test',requestId:'init-publisher',expectedRevision:0,expectedChecksum:'GENESIS',action:'init',data:{publisherId:'isolated-publisher',sourceEpoch:'local-1'}});
  const args={store:f.store,coordinator:f.coordinator,guildId,applicationId:id,publisherId:'isolated-publisher',sourceEpoch:'local-1',sourceSequence:10,actorId:'isolated-publisher',snapshots:[{snapshotType:'analytics',aggregateId:`v2:guild:${guildId}:current`,snapshotVersion:1,generatedAt:1000,checksum:'fixture',payload:{lastUpdatedAt:1000}}]};
  await publishApplicationProjection(args);
  await assert.rejects(publishApplicationProjection({...args,sourceSequence:9}),{code:'APP_STALE_SOURCE'});
  await assert.rejects(publishApplicationProjection({...args,publisherId:'old'}),{code:'APP_PUBLISHER_FENCED'});
  await assert.rejects(publishApplicationProjection({...args,snapshots:[]}),{code:'APP_SOURCE_CONFLICT'});
  const router=createApplicationProjectionRouter({store:f.store,actorId:'web-reader',controlId:id,now:()=>1000+9000000});
  const read=await router.readAnalyticsBundle({guildId});assert.equal(read.available,true);assert.equal(read.metadata.freshness,'very_stale');assert.equal(read.metadata.provider,'cloud-quorum');
});
test('rate limit survives Neon loss; bounded CAS conflicts and quorum loss cannot allow a mutation',async t=>{
  const f=await applicationFixture(t),o={coordinator:f.coordinator,controlId:f.plan.controlId,key:'opaque-user-hash',limit:2,windowMs:60000,at:123456};
  assert.equal(await quorumRateLimited(o),false);assert.equal(await quorumRateLimited(o),false);assert.equal(await quorumRateLimited(o),true);
  f.faults.supabase=true;assert.equal(await quorumRateLimited({...o,key:'new'}),true);
});
test('same idempotent intent is not duplicated and artifact identities isolate epoch, Guild, domain and user',async t=>{
  const f=await applicationFixture(t),i={domain:'goals',guildId,ownerId:user,actorId:user,expectedEpoch:f.plan.epoch,expectedRevision:0,expectedChecksum:'GENESIS',acknowledgeUnconfirmed:true,requestId:'idempotent',data:goals};
  const a=await f.store.write(i),b=await f.store.write(i);assert.equal(a.checksum,b.checksum);
  const base={epoch:f.plan.epoch,domain:'goals',guildId,ownerId:user};
  assert.equal(new Set([base,{...base,ownerId:'other'},{...base,epoch:'new'},{...base,guildId:'100000000000000002'}].map(applicationArtifact)).size,4);
});
for(const failed of ['neon','supabase','turso'])test(`initialized application quorum remains available with ${failed} alone offline`,async t=>{
 const f=await applicationFixture(t);await f.save('goals',goals,{ownerId:user});f.faults.neon=false;await f.providers[0].initializeMembership(f.coordinator.membership);
 const c=createCoordinator({providers:f.providers,epoch:f.plan.epoch});await c.read(guildId);
 const plane=createDataPlane({coordinator:c,stores:f.stores}),s=createApplicationStore({coordinator:c,dataPlane:plane,authorize:async()=>true,key:Buffer.alloc(32,7),keyId:'isolated-test-key'});
 const input={domain:'goals',guildId,ownerId:user,actorId:user};await s.repair(input);await s.read(input);f.faults[failed]=true;
 const old=await s.read(input);assert.deepEqual(old.data,goals);
 await s.write({...input,data:{goals:[]},requestId:'clear-explicit',expectedEpoch:old.epoch,expectedRevision:old.revision,expectedChecksum:old.checksum});assert.deepEqual((await s.read(input)).data,{goals:[]});
});
test('bounded checkpoint permits repeated application writes beyond per-recovery log limit without deleting history',async t=>{
 const f=await applicationFixture(t),c=createCoordinator({providers:f.providers,epoch:f.plan.epoch,maxSlots:5});
 const plane=createDataPlane({coordinator:c,stores:f.stores}),s=createApplicationStore({coordinator:c,dataPlane:plane,authorize:async()=>true,key:Buffer.alloc(32,7),keyId:'isolated-test-key'}),input={domain:'goals',guildId,ownerId:user,actorId:user};
 for(let n=1;n<=9;n++){
  const old=await s.read(input);await s.write({...input,data:{goals:[{type:'messages',target:n}]},requestId:'bounded-'+n,acknowledgeUnconfirmed:true,expectedEpoch:old.epoch,expectedRevision:old.revision,expectedChecksum:old.checksum});
  if(n%3===0)await plane.checkpoint({guildId,artifactId:old.artifactId,key:Buffer.alloc(32,7),keyId:'isolated-test-key',actorId:'checkpoint-test',requestId:'checkpoint-'+n,minRevisions:3});
 }
 assert.equal((await s.read(input)).data.goals[0].target,9);
 const artifact=applicationArtifact({epoch:f.plan.epoch,domain:'goals',guildId,ownerId:user});
 assert.ok(f.dbs[1].prepare(`SELECT count(*) n FROM ${f.tablePrefix}mdb_acceptor WHERE guild_id LIKE ?`).get('%'+guildId).n>9);
 void artifact;
});
test('repair catalog is durable, bounded and does not need private decryption keys to reconstruct shards',async t=>{
 const f=await applicationFixture(t);await f.save('goals',goals,{ownerId:user});f.faults.neon=false;
 const c=createCoordinator({providers:f.providers,epoch:f.plan.epoch});await f.providers[0].initializeMembership(c.membership);await c.read(guildId);
 const repair=createApplicationRepairer({coordinator:c,dataPlane:createDataPlane({coordinator:c,stores:f.stores}),controlId:f.plan.controlId,intervalMs:0});
 await repair.processOnce();assert.equal(repair.status().state,'CONSISTENT');
 assert.ok(f.dbs[0].prepare(`SELECT count(*) n FROM ${f.tablePrefix}mdb_blob_shard`).get().n>0);
});
test('encrypted checkpoint archives themselves enter the durable repair catalog',async t=>{
 const f=await applicationFixture(t);
 for(let n=1;n<=3;n++)await f.save('goals',{goals:[{type:'messages',target:n}]},{ownerId:user});
 const repair=createApplicationRepairer({coordinator:f.coordinator,dataPlane:f.dataPlane,controlId:f.plan.controlId,key:Buffer.alloc(32,7),keyId:'isolated-test-key',intervalMs:0,checkpointInterval:3});
 await repair.processOnce();assert.notEqual(repair.status().state,'DEGRADED');
 const catalog=await f.coordinator.scoped('application-repair').read(guildId);assert.equal(catalog.value.data.artifactIds.length,2);
});
test('worker publication failure is visible, never advances snapshot delivery and cannot fall back to Neon SQL',async t=>{
 const f=await applicationFixture(t),publisher=createApplicationPublisher({runtime:{coordinator:f.coordinator,dataPlane:f.dataPlane},storage:{snapshots:{listGuildSnapshots:()=>[]}},applicationId:f.plan.controlId,publisherId:'uninitialized',sourceEpoch:'source-1'});
 await publisher.processOnce();assert.equal(publisher.status().state,'DEGRADED');assert.equal(publisher.status().lastSuccess,null);
});
test('worker restart resumes durable SQLite projections; SQLite failure retains old chosen state and reports degraded',async t=>{
 const f=await applicationFixture(t),publisherId='a'.repeat(32),sourceEpoch='b'.repeat(32),controlId=f.plan.controlId;
 await f.coordinator.scoped('application-publisher').update({guildId:controlId,actorId:'approved-test',requestId:'init-worker',expectedRevision:0,expectedChecksum:'GENESIS',action:'init',data:{publisherId,sourceEpoch}});
 let broken=false,at=100000;const storage={snapshots:{listGuildSnapshots:()=>{if(broken)throw Error('SQLITE_CORRUPT');return[{snapshotType:'analytics',aggregateId:`v2:guild:${guildId}:current`,snapshotVersion:1,generatedAt:100000,payload:{}}];},get:()=>null}};
 const make=()=>createApplicationPublisher({runtime:{coordinator:f.coordinator,dataPlane:f.dataPlane},storage,applicationId:controlId,publisherId,sourceEpoch,now:()=>at});
 let p=make();await p.processOnce();assert.equal(p.status().state,'CONSISTENT');
 const old=await f.store.read({domain:'analytics',guildId,actorId:'fixture-reader'});
 p=make();await p.processOnce();assert.equal((await f.store.read({domain:'analytics',guildId,actorId:'fixture-reader'})).checksum,old.checksum);
 broken=true;at+=31000;await p.processOnce();assert.equal(p.status().state,'DEGRADED');assert.equal((await f.store.read({domain:'analytics',guildId,actorId:'fixture-reader'})).checksum,old.checksum);
});
test('support side effect: encrypted durable claim, one send, UNKNOWN is never retried and changed intent conflicts',async t=>{
 const f=await applicationFixture(t);let calls=0;
 const store=createApplicationStore({coordinator:f.coordinator,dataPlane:f.dataPlane,key:Buffer.alloc(32,7),keyId:'isolated-test-key',authorize:async({domain,guildId})=>domain==='support'&&guildId===f.plan.controlId});
 const args={store,controlId:f.plan.controlId,actorId:'support-form',requestId:'c'.repeat(32),form:{name:'合成',email:'fixture@example.invalid',message:'synthetic only'},send:async()=>{calls++;throw Error('PROVIDER_TIMEOUT_SECRET_MUST_NOT_LOG');}};
 const r=await submitApplicationSupport(args);assert.equal(r.delivery,'UNKNOWN');assert.equal(calls,1);
 const replay=await submitApplicationSupport(args);assert.equal(replay.delivery,'UNKNOWN');assert.equal(calls,1);
 await assert.rejects(submitApplicationSupport({...args,form:{...args.form,message:'different'}}),{code:'APP_SUPPORT_CONFLICT'});
 const failed=await submitApplicationSupport({...args,requestId:'d'.repeat(32),send:async()=>false});assert.equal(failed.delivery,'FAILED');
 const sent=await submitApplicationSupport({...args,requestId:'e'.repeat(32),send:async()=>true});assert.equal(sent.delivery,'SENT');
});
