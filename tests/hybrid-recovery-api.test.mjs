import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import ts from 'typescript';import {createRequire} from 'node:module';
import * as policy from '../lib/guild-spam-policy.mjs';
import * as consent from '../lib/security-v2-consent.mjs';
import * as recovery from '../lib/multi-db/recovery-state.mjs';
import {recoveryFixture,recoveryGuild as guild} from './helpers/recovery-fixture.mjs';
const require=createRequire(import.meta.url);
function routeFor(f,{allowed=true,session=true,runtime=f,legacyQuery=async()=>{throw Error('LEGACY_NEON_MUST_NOT_BE_READ');}}={}){
 const source=fs.readFileSync(new URL('../app/api/guilds/[guildId]/security/spam-policy/route.ts',import.meta.url),'utf8');
 const mocks={'@/lib/auth':{auth:{api:{getSession:async()=>session?{user:{id:'fixture-user'}}:null}}},'@/lib/auth-storage':{authStorage:{rateLimit:{isLimited:async()=>false}}},'@/lib/db':{pool:{query:legacyQuery}},'@/lib/multi-db/web-runtime':{getSecurityCoordinator:async()=>runtime},'@/lib/discord':{getManagedGuilds:async()=>allowed?[{id:guild}]:[]},'@/lib/request-security':{hasJsonBody:()=>true,isTrustedMutation:r=>r.headers.get('origin')==='https://isolated.invalid'},'@/lib/guild-spam-policy.mjs':policy,'@/lib/security-v2-consent.mjs':consent,'@/lib/multi-db/recovery-state.mjs':recovery};
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const loaded={exports:{}};new Function('require','module','exports',js)(id=>id in mocks?mocks[id]:require(id),loaded,loaded.exports);
 return loaded.exports;
}
const context=id=>({params:Promise.resolve({guildId:id??guild})});
const req=(method='GET',body=null,origin='https://isolated.invalid')=>new Request(`https://isolated.invalid/api/guilds/${guild}/security/spam-policy`,{method,headers:{Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
test('actual API source: Neon-free read → unconfirmed UI draft → explicitly reviewed save → new confirmed read',async t=>{
 const f=await recoveryFixture(t),api=routeFor(f);const r=await api.GET(req(),context());assert.equal(r.status,200);
 const b=await r.json();assert.equal(b.configurationState,'unconfirmed');assert.equal(b.isCustom,false);assert.equal(b.auto.consentState,'unconfirmed');
 const wrongEpoch=await api.PUT(req('PUT',{policy:b.policy,concurrency:{...b.concurrency,epoch:'retired-epoch'},acknowledgeRecovery:b.recoveryId,requestId:'wrong-epoch'}),context());assert.equal(wrongEpoch.status,409);assert.equal((await wrongEpoch.json()).code,'MDB_EPOCH_CONFLICT');
 let response=await api.PUT(req('PUT',{policy:b.policy,concurrency:b.concurrency,requestId:'missing-review'}),context());assert.equal(response.status,409);assert.equal((await response.json()).code,'MDB_RECOVERY_ACK_REQUIRED');
 response=await api.PUT(req('PUT',{policy:{...b.policy,strength:71},concurrency:b.concurrency,acknowledgeRecovery:b.recoveryId,requestId:'confirmed-review'}),context());assert.equal(response.status,200);
 const saved=await response.json();assert.equal(saved.configurationState,'configured');assert.equal(saved.policy.strength,71);assert.equal(saved.auto.autoTimeout,false);assert.equal(saved.auto.consentState,'unconfirmed');
 assert.equal((await(await api.GET(req(),context())).json()).policy.strength,71);
 response=await api.PUT(req('PUT',{policy:b.policy,concurrency:b.concurrency,requestId:'stale'}),context());assert.equal(response.status,409);
});
test('actual API: session, Guild boundary and trusted mutation checks are preserved',async t=>{
 const f=await recoveryFixture(t);
 assert.equal((await routeFor(f,{session:false}).GET(req(),context())).status,401);
 assert.equal((await routeFor(f,{allowed:false}).GET(req(),context())).status,403);
 assert.equal((await routeFor(f).GET(req(),context('100000000000000002'))).status,403);
 assert.equal((await routeFor(f).PUT(req('PUT',{},'https://foreign.invalid'),context())).status,400);
});
test('actual API: unset, unconfirmed, lost quorum and Neon legacy failure have distinct finite responses',async t=>{
 const f=await recoveryFixture(t),api=routeFor(f,{allowed:true});
 const missingApi=routeFor(f,{runtime:{security:{read:async()=>{throw Object.assign(Error(),{code:'MDB_NOT_ENROLLED'});}}}});
 const unset=await missingApi.GET(req(),context());assert.equal(unset.status,409);assert.equal((await unset.json()).configurationState,'unset');
 f.faults.supabase=true;const unavailable=await api.GET(req(),context());assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).configurationState,'unavailable');
 const old=await routeFor(f,{runtime:null,legacyQuery:async()=>{throw Object.assign(Error(),{code:'53000'});}}).GET(req(),context());assert.equal(old.status,503);assert.equal((await old.json()).code,'CONFIGURATION_DB_UNAVAILABLE');
});
test('actual API: policy-only confirmation cannot authorize an auto-on while emergency state is unknown',async t=>{
 const f=await recoveryFixture(t),api=routeFor(f),b=await(await api.GET(req(),context())).json();
 const s=await(await api.PUT(req('PUT',{policy:b.policy,concurrency:b.concurrency,acknowledgeRecovery:b.recoveryId,requestId:'normal-setting'}),context())).json();
 const r=await api.PATCH(req('PATCH',{operation:'on',concurrency:s.concurrency,requestId:'no-implicit-consent'}),context());assert.equal(r.status,409);assert.equal((await r.json()).code,'MDB_SAFETY_UNCONFIRMED');
});
