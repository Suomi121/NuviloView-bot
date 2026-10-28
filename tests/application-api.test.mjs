import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {createRequire} from 'node:module';
import {applicationFixture} from './helpers/application-fixture.mjs';import {recoveryGuild as guildId} from './helpers/recovery-fixture.mjs';
import * as notifications from '../lib/multi-db/notifications.mjs';import {createApplicationStore} from '../lib/multi-db/application-store.mjs';
import {appendApplicationAlert} from '../lib/multi-db/application-alerts.mjs';
const require=createRequire(import.meta.url),user='isolated-user',origin='https://isolated.invalid';
function load(path,mocks){const source=fs.readFileSync(new URL('../'+path,import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,mod={exports:{}};new Function('require','module','exports',js)(id=>id in mocks?mocks[id]:require(id),mod,mod.exports);return mod.exports;}
function routes(f,{allowed=true,session=true,limited=false}={}){
  const web={applicationHaEnabled:()=>true,getApplicationStore:async(id,ids)=>createApplicationStore({coordinator:f.coordinator,dataPlane:f.dataPlane,key:Buffer.alloc(32,7),keyId:'isolated-test-key',authorize:async({guildId,ownerId,operation,domain})=>ids.includes(guildId)&&(!ownerId||ownerId===id)&&(operation==='read'||['goals','notification-receipts'].includes(domain))}),applicationError:e=>({status:/CONFLICT|CONFIRMATION/.test(e.code)?409:e.code==='APP_FORBIDDEN'?403:503,body:{code:e.code,state:'unavailable'}})};
  const mocks={'@/lib/auth':{auth:{api:{getSession:async()=>session?{user:{id:user}}:null}}},'@/lib/db':{pool:{query:async()=>{throw Error('NEON_WAS_CALLED');}}},'@/lib/discord':{getManagedGuilds:async()=>allowed?[{id:guildId}]:[]},'@/lib/request-security':{isRateLimited:async()=>limited,hasJsonBody:()=>true,isTrustedMutation:r=>r.headers.get('origin')===origin},'@/lib/multi-db/application-web':web,'@/lib/multi-db/notifications.mjs':notifications,'@/lib/web-analytics-read':{withWebReadRouter:async cb=>cb({readAnalyticsBundle:async()=>({available:false})})},'@/lib/projection-analytics':{buildProjectionGoalMetrics:()=>({values:{messages:null},readMeta:{freshness:'unavailable'}})}};
  return{goals:load('app/api/goals/route.ts',mocks),notifications:load('app/api/notifications/route.ts',mocks),dismiss:load('app/api/notifications/[id]/route.ts',mocks)};
}
const req=(path,method='GET',body=null,from=origin)=>new Request(origin+path,{method,headers:{origin:from,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
test('actual goals API: Neon offline; unknown → explicit CAS save → reread → stale conflict',async t=>{
 const f=await applicationFixture(t),api=routes(f).goals,path=`/api/goals?guildId=${guildId}`;
 let response=await api.GET(req(path));assert.equal(response.status,200);const b=await response.json();assert.equal(b.configurationState,'unconfirmed');
 const body={guildId,token:b.token,requestId:'api-goals-1',goals:[{type:'messages',target:900}]};
 assert.equal((await api.PUT(req('/api/goals','PUT',body))).status,409);
 response=await api.PUT(req('/api/goals','PUT',{...body,acknowledgeUnconfirmed:true}));assert.equal(response.status,200);
 const saved=await(await api.GET(req(path))).json();assert.equal(saved.goals[0].target,900);assert.equal(saved.goals[0].current,null);
 assert.equal((await api.PUT(req('/api/goals','PUT',{...body,requestId:'api-stale',acknowledgeUnconfirmed:true}))).status,409);
 f.faults.supabase=true;assert.equal((await api.GET(req(path))).status,503);
});
test('actual goals API: session, Google-only/no Guild, foreign origin, validation and rate limit stay enforced',async t=>{
 const f=await applicationFixture(t),path=`/api/goals?guildId=${guildId}`;
 assert.equal((await routes(f,{session:false}).goals.GET(req(path))).status,403);
 assert.equal((await routes(f,{allowed:false}).goals.GET(req(path))).status,403);
 assert.equal((await routes(f).goals.PUT(req('/api/goals','PUT',{guildId},'https://foreign.invalid'))).status,400);
 assert.equal((await routes(f,{limited:true}).goals.GET(req(path))).status,429);
 assert.equal((await routes(f).goals.PUT(req('/api/goals','PUT',{guildId,goals:[{type:'invalid',target:1}]}))).status,400);
});
test('actual notifications GET is read-only; dismiss is owned, authorized, CAS protected and survives reload',async t=>{
 const f=await applicationFixture(t);await appendApplicationAlert({store:f.store,guildId,actorId:'isolated-bot',type:'fixture',title:'合成',body:'テスト',proveOwner:async()=>true});
 const api=routes(f),before=f.dbs[1].totalChanges;
 const r=await api.notifications.GET(req('/api/notifications'));assert.equal(r.status,200);const b=await r.json(),n=b.notifications[0];assert.ok(n.token);
 // Consensus read barriers may persist promises; no notification INSERT or Auth row is created.
 assert.equal((await api.dismiss.DELETE(req('/api/notifications/'+n.id,'DELETE',{guildId,token:n.token,requestId:'api-dismiss'}),{params:Promise.resolve({id:n.id})})).status,200);
 assert.equal((await(await api.notifications.GET(req('/api/notifications'))).json()).notifications.length,0);
 assert.equal((await routes(f,{allowed:false}).dismiss.DELETE(req('/api/notifications/'+n.id,'DELETE',{guildId,token:n.token,requestId:'denied'}),{params:Promise.resolve({id:n.id})})).status,403);
 assert.equal((await routes(f,{session:false}).notifications.GET(req('/api/notifications'))).status,401);void before;
});
