import test from 'node:test';import assert from 'node:assert/strict';
import {recoveryFixture,recoveryGuild as g,recoveryActor as actor,recoveryEvidence} from './helpers/recovery-fixture.mjs';
import {bootstrapUnconfirmedRecovery,recoveryPrefix,validateRecoveryPlan} from '../lib/multi-db/recovery-bootstrap.mjs';
import {createCoordinator,checksum} from '../lib/multi-db/coordinator.mjs';
import {quarantineVoter,rejoinVoter} from '../lib/multi-db/rejoin.mjs';
import {createSecurityService,validateSecurityData} from '../lib/multi-db/security-service.mjs';
import {fetchJsonBounded} from '../lib/bounded-json.mjs';
import {readOperatorRoles} from '../lib/security-operators.mjs';
import {readTimeoutLogChannel} from '../lib/security-log-settings.mjs';
import {createQuorumNewsControl} from '../lib/multi-db/news-control.mjs';
import {normalizeSyncEnvelope} from '../lib/sync/conflict-policy.mjs';
import {newsFixture} from './helpers/news-fixture.mjs';
import {createNewsService} from '../lib/news-service.mjs';
import {createSecurityCoordinatorRuntime} from '../lib/multi-db/runtime.mjs';

test('Neon absent: explicitly approved new epoch uses Supabase/Turso; no snapshot, no legacy mutation',async t=>{
 const f=await recoveryFixture(t),s=await f.security.read(g);
 assert.equal(s.value.data.migrationState,'unconfirmed');assert.ok(Object.values(s.value.data.verification).every(v=>v===false));
 assert.equal(s.value.data.autoTimeout,false);assert.equal(s.value.data.emergencyStop,true);
 for(const db of f.dbs)assert.equal(db.prepare('SELECT membership FROM mdb_membership').get().membership,'unmodified-legacy-membership');
 assert.equal(f.dbs[0].prepare(`SELECT count(*) n FROM ${recoveryPrefix(f.plan.epoch)}mdb_membership`).get().n,0);
 assert.equal(await f.security.automaticAllowed(g,{emergencyStop:false}),false);
});
for(const flag of ['allWritersInventoried','discordPunishersDrained','legacySqlWriteAccessRevoked','oldDeploymentsFenced','localStateRestorable','legacyDataRetained'])test(`missing external fence evidence ${flag} refuses bootstrap`,async t=>{
 const f=await recoveryFixture(t,{bootstrap:false});f.evidence[flag]=false;
 await assert.rejects(bootstrapUnconfirmedRecovery(f.args),{code:'MDB_RECOVERY_FENCE_EVIDENCE'});
 assert.equal(f.dbs[1].prepare(`SELECT count(*) n FROM ${recoveryPrefix(f.plan.epoch)}mdb_membership`).get().n,0);
});
test('freshness / approval / namespace / conflicting membership are not guessed',async t=>{
 const f=await recoveryFixture(t,{bootstrap:false});await assert.rejects(bootstrapUnconfirmedRecovery({...f.args,approval:'wrong'}),{code:'MDB_RECOVERY_APPROVAL'});
 await assert.rejects(bootstrapUnconfirmedRecovery({...f.args,evidence:{...f.evidence,verifiedAt:'2000-01-01'}}),{code:'MDB_RECOVERY_FENCE_EVIDENCE'});
 f.dbs[1].prepare(`INSERT INTO ${recoveryPrefix(f.plan.epoch)}mdb_membership VALUES(1,?,?)`).run('conflicting-epoch','supabase');
 await assert.rejects(bootstrapUnconfirmedRecovery(f.args),{code:'MDB_MEMBERSHIP_MISMATCH'});
});
test('unconfirmed policy requires explicit full review; save does not silently confirm consent, stop, roles or logs',async t=>{
 const f=await recoveryFixture(t),s=await f.security.read(g);
 await assert.rejects(f.change('level',80),{code:'MDB_POLICY_UNCONFIRMED'});
 const policy={...s.value.data.policy,strength:80};
 await assert.rejects(f.change('policy',policy),{code:'MDB_RECOVERY_ACK_REQUIRED'});
 await f.change('policy',policy,{acknowledgeRecovery:f.planChecksum});
 const next=(await f.security.read(g)).value.data;assert.equal(next.verification.policy,true);assert.equal(next.verification.autoTimeout,false);assert.equal(next.emergencyStop,true);
 await f.change('level',25);assert.equal((await f.security.read(g)).value.data.policy.strength,25);
 await assert.rejects(f.change('auto:on'),{code:'MDB_SAFETY_UNCONFIRMED'});
 await f.change('auto:off');assert.equal((await f.security.read(g)).value.data.verification.autoTimeout,true);
});
test('explicit reconfirmation can safely enable in future, without permanent disable; emergency/off and policy are prerequisites',async t=>{
 const f=await recoveryFixture(t),s=await f.security.read(g);
 await f.change('policy',s.value.data.policy,{acknowledgeRecovery:f.planChecksum});
 await assert.rejects(f.change('emergency:off'),{code:'MDB_RECOVERY_ACK_REQUIRED'});
 await f.change('emergency:off',null,{acknowledgeRecovery:f.planChecksum});
 assert.equal(await f.security.automaticAllowed(g,{emergencyStop:false}),false);
 await f.change('auto:on');assert.equal(await f.security.automaticAllowed(g,{emergencyStop:false}),true);
 await f.change('emergency:on');assert.equal(await f.security.automaticAllowed(g,{emergencyStop:false}),false);
});
test('unconfirmed operator/log never delegate or fall back publicly; explicit owner/admin updates confirm only their fields',async t=>{
 const f=await recoveryFixture(t);await assert.rejects(readOperatorRoles(null,g,f.security),{code:'MDB_OPERATOR_UNCONFIRMED'});
 await assert.rejects(readTimeoutLogChannel(null,g,f.security),{code:'MDB_LOG_UNCONFIRMED'});
 await f.change('operator:add',actor);assert.deepEqual(await readOperatorRoles(null,g,f.security),[actor]);
 await f.change('log:off');assert.equal(await readTimeoutLogChannel(null,g,f.security),null);
 assert.equal((await f.security.read(g)).value.data.verification.autoTimeout,false);
 await assert.rejects(f.change('operator:add','100000000000000004',{authorize:async()=>false}),{code:'MDB_FORBIDDEN'});
});
test('lost second voter, other Guild, stale CAS and concurrent Web/Bot writers deny safely',async t=>{
 const f=await recoveryFixture(t),s=await f.security.read(g);
 await assert.rejects(f.security.read('100000000000000002'),{code:'MDB_NOT_ENROLLED'});
 const input={guildId:g,actorId:actor,requestId:'race',expectedRevision:s.value.revision,expectedChecksum:s.checksum,operation:'auto:off',authorize:async()=>true};
 const result=await Promise.allSettled([f.security.change(input),f.security.change({...input,requestId:'other-race'})]);assert.equal(result.filter(v=>v.status==='fulfilled').length,1);
 await assert.rejects(f.security.change({...input,requestId:'stale'}),{code:'MDB_REVISION_CONFLICT'});
 f.faults.supabase=true;await assert.rejects(f.security.read(g));assert.equal(await f.security.automaticAllowed(g,{emergencyStop:false}),false);
});
test('partial bootstrap resumes exact certificate, keeps new admin values; old record remains read-only history',async t=>{
 const f=await recoveryFixture(t);await f.change('auto:off');const before=await f.security.read(g);
 await bootstrapUnconfirmedRecovery(f.args);assert.equal((await f.security.read(g)).checksum,before.checksum);
 const c=createCoordinator({providers:f.providers.map(p=>quarantineVoter(p,new Set(['neon']))),epoch:f.plan.epoch});
 assert.equal((await createSecurityService(c).read(g)).checksum,before.checksum);
});
test('Neon return cannot overwrite chosen state; explicit prefixed rejoin catches up from original two voters',async t=>{
 const f=await recoveryFixture(t);await f.change('auto:off');const expected=await f.security.read(g);f.faults.neon=false;
 assert.equal((await f.security.read(g)).checksum,expected.checksum);
 await f.providers[0].initializeMembership(f.coordinator.membership);
 await rejoinVoter({providers:f.providers,epoch:f.plan.epoch,targetId:'neon'});
 const c=createCoordinator({providers:f.providers,epoch:f.plan.epoch});assert.equal((await c.read(g)).checksum,expected.checksum);
});
test('malformed/forged unknown security state is rejected instead of interpreted as confirmation',async t=>{
 const f=await recoveryFixture(t),s=(await f.security.read(g)).value.data;
 for(const d of [{...s,autoTimeout:true},{...s,emergencyStop:false},{...s,operatorRoleIds:[actor]},{...s,logChannelId:actor},{...s,verification:null}])assert.throws(()=>validateSecurityData(d));
});
test('new epoch news destination/claims use same two voters; missing destination explicitly unconfirmed',async t=>{
 const f=await recoveryFixture(t),c={...f.coordinator,recovery:{planChecksum:f.planChecksum}},news=createQuorumNewsControl(c);
 assert.equal((await news.destination(g)).confirmed,false);await news.setDestination(actor,g,'200000000000000001');assert.equal((await news.destination(g)).confirmed,true);
 const e=normalizeSyncEnvelope({eventId:`news:${'a'.repeat(32)}:${g}:1:claim`,domain:'security',eventType:'news_delivery_claim_v1',aggregateId:'fixture',createdAt:1,payload:{claimNonce:'synthetic'}});
 await news.claim(e);assert.equal(await news.verify(e.eventId,e.checksum),true);assert.equal(news.epoch,f.plan.epoch);
});
test('finite read timeout includes a stalled response body and ignores adapters that never honor abort',async()=>{
 const started=Date.now();await assert.rejects(fetchJsonBounded('/synthetic',{timeoutMs:25,fetcher:()=>new Promise(()=>{})}));assert.ok(Date.now()-started<1000);
 await assert.rejects(fetchJsonBounded('/synthetic',{timeoutMs:25,fetcher:async()=>({ok:true,json:()=>new Promise(()=>{})})}));
 await assert.rejects(fetchJsonBounded('/synthetic',{fetcher:async()=>({ok:false,status:409,json:async()=>({code:'MDB_NOT_ENROLLED',configurationState:'unset'})})}),{code:'MDB_NOT_ENROLLED',configurationState:'unset'});
 const a=await fetchJsonBounded('/synthetic',{fetcher:async()=>({ok:true,json:async()=>({configurationState:'unconfirmed'})})});assert.equal(a.configurationState,'unconfirmed');
});

test('17 synthetic Guilds recover as explicitly unconfirmed without resetting legacy tables or consenting',async t=>{
 const f=await recoveryFixture(t,{bootstrap:false}),plan={...f.plan,guilds:Array.from({length:17},(_,i)=>String(100000000000000001n+BigInt(i)))};
 const r=await bootstrapUnconfirmedRecovery({...f.args,plan,evidence:recoveryEvidence(plan),approval:validateRecoveryPlan(plan)});assert.equal(r.complete,17);
 for(const id of plan.guilds){const state=(await r.security.read(id)).value.data;assert.equal(state.verification.autoTimeout,false);assert.equal(await r.security.automaticAllowed(id,{emergencyStop:false}),false);}
});
test('partial initial membership failure is resumable, never treated as working quorum',async t=>{
 const f=await recoveryFixture(t,{bootstrap:false});f.faults.turso=true;await assert.rejects(bootstrapUnconfirmedRecovery(f.args));f.faults.turso=false;
 const r=await bootstrapUnconfirmedRecovery(f.args);assert.equal(r.complete,1);assert.equal((await r.security.read(g)).value.data.migrationState,'unconfirmed');
});
test('old publication is paused across epochs, not granted a fresh claim or blindly resent',async t=>{
 const local=newsFixture(t),publication=await local.queued();let sends=0;
 const resumed=createNewsService({...local.options,cloud:{...local.cloud,epoch:'new-epoch',recovery:true}});
 await resumed.deliverOne(publication.id,{validate:async()=>{},send:async()=>{sends++;}});
 assert.equal(sends,0);assert.equal(resumed.get(publication.id).state,'paused');assert.equal(resumed.get(publication.id).suspensionReason,'NEWS_AUTHORITY_TRANSFER_REQUIRED');
});
test('dedicated coordinator connection cannot reuse Auth database identity',async()=>{
 await assert.rejects(createSecurityCoordinatorRuntime({SECURITY_COORDINATOR_MODE:'quorum',SECURITY_COORDINATOR_SUPABASE_URL:'postgresql://user:dummy@127.0.0.1/auth',WEB_AUTH_SUPABASE_DATABASE_URL:'postgresql://user:dummy@127.0.0.1/auth'}),/MDB_DATABASE_SEPARATION_REQUIRED/);
});
test('numeric Guild identities and reusing retired epoch are rejected before any write',async t=>{
 const f=await recoveryFixture(t,{bootstrap:false});for(const patch of [{guilds:[100000000000000001]},{epoch:f.plan.retiredEpochs[0]},{controlId:100000000000000009}])assert.throws(()=>validateRecoveryPlan({...f.plan,...patch}),{code:'MDB_RECOVERY_PLAN'});
});
