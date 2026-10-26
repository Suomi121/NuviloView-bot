import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coordinator-fixture.mjs';
import { initializeRuntimeOwner,QuorumRuntimeOwner } from '../lib/multi-db/runtime-owner.mjs';
const applicationId='900000000000000001';
test('Neon outage: quorum owner continues; second Bot and uninitialized ownership refused, no timed takeover',async t=>{
 const f=fixture(t),lost=[];
 const owner=id=>new QuorumRuntimeOwner({coordinator:f.c,applicationId,identity:{instanceId:id,hostId:'isolated'},config:{renewSeconds:10},onLeaseLost:async()=>lost.push(id)});
 await assert.rejects(owner('uninitialized').acquire(),{code:'MDB_NOT_ENROLLED'});
 await initializeRuntimeOwner(f.c,applicationId,'approved-owner');f.faults.neon='offline';
 const a=owner('a'),b=owner('b');assert.equal((await a.acquire()).acquired,true);assert.equal((await b.acquire()).acquired,false);
 await a.recordNow();assert.equal(a.leaseState,'Owned');assert.equal(lost.length,0);
 f.faults.turso='offline';await a.recordNow();assert.deepEqual(lost,['a']);
 f.faults.turso=null;assert.equal((await b.acquire()).acquired,false,'lost owner never auto-expires');
 await a.stop({release:false});
});
test('graceful disconnect then explicit release allows next owner; stale instance is fenced',async t=>{
 const f=fixture(t);await initializeRuntimeOwner(f.c,applicationId,'approved-owner');
 const create=id=>new QuorumRuntimeOwner({coordinator:f.c,applicationId,identity:{instanceId:id,hostId:'isolated'},config:{renewSeconds:10},onLeaseLost:async()=>{}});
 const a=create('a'),b=create('b');await a.acquire();await a.stop({release:true});assert.equal(a.leaseState,'Released');
 assert.equal((await b.acquire()).acquired,true);await assert.rejects(a.prove(),{code:'MDB_RUNTIME_FENCED'});await b.stop();
});
test('legacy Neon monitor failure is advisory, not quorum loss; final heartbeat retains authority metadata',async t=>{
 const f=fixture(t);await initializeRuntimeOwner(f.c,applicationId,'approved-owner');let fail=true;const beats=[];
 const a=new QuorumRuntimeOwner({coordinator:f.c,applicationId,identity:{instanceId:'a',hostId:'isolated'},config:{renewSeconds:10,serviceKey:'test'},
  onLeaseLost:async()=>assert.fail('no false lease loss'),repository:{writeHeartbeat:async b=>{if(fail)throw Error('Neon unavailable');beats.push(b);}}});
 await a.acquire();await a.recordNow();assert.equal(a.leaseState,'Owned');assert.equal(a.heartbeatState,'LEGACY_MONITOR_UNAVAILABLE');
 fail=false;await a.recordNow();await a.stop();assert.equal(beats.at(-1).status,'Stopped');assert.equal(beats.at(-1).metadata.authority,'cloud-quorum');assert.equal(beats.at(-1).fencingToken,null);
});
