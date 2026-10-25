import test from 'node:test';
import assert from 'node:assert/strict';
import { securityFixture,guild } from './helpers/quorum-fixture.mjs';
import { evidenceFixture } from './helpers/security-evidence-fixture.mjs';
import { guildId,roleId } from './helpers/security-operator-fixture.mjs';
import { createSecurityService } from '../lib/multi-db/security-service.mjs';
const incident='timeout-'+'a'.repeat(40);
test('explicit consent + live quorum permits one global Incident claim, never implicit ON or retry',async t=>{
 const f=await securityFixture(t);f.faults.neon='offline';
 assert.equal(await f.security.claimAutomaticIncident(guild,incident,{emergencyStop:false}),false);
 await f.change('auto:on');
 const options={emergencyStop:false,expectedPolicy:(await f.security.read(guild)).value.data.policy};
 assert.equal(await f.security.claimAutomaticIncident(guild,incident,{emergencyStop:false}),false,'unbound detection context denied');
 const outcomes=await Promise.all([f.security.claimAutomaticIncident(guild,incident,options),f.security.claimAutomaticIncident(guild,incident,options)]);
 assert.ok(outcomes.filter(Boolean).length<=1);
 assert.equal(await f.security.claimAutomaticIncident(guild,incident,options),false);
 assert.equal(await f.security.claimAutomaticIncident(guild,'timeout-'+'b'.repeat(40),{emergencyStop:true}),false);
 await f.change('auto:off');assert.equal(await f.security.automaticAllowed(guild,{emergencyStop:false}),false);
});
test('Evidence delegated roles use fresh quorum even with Neon SQL denied; revocation and outage refuse TXT',async t=>{
 const f=await securityFixture(t),e=evidenceFixture({kind:'operator'});t.after(()=>e.storage.close());
 assert.equal(guildId,guild);await f.change('operator:add',roleId);
 f.faults.neon='offline';
 const handler=e.handler({security:f.security,query:async()=>{throw Error('NO_LEGACY_NEON');}});
 await handler(e.interaction());assert.ok(e.replies.at(-1).files?.[0]);
 const state=await f.security.read(guildId);
 await f.security.change({guildId,actorId:'isolated',requestId:'revoke',expectedRevision:state.value.revision,expectedChecksum:state.checksum,operation:'operator:remove',value:roleId,authorize:async()=>true});
 await handler(e.interaction());assert.equal(e.replies.at(-1).files,undefined);
 f.faults.turso='offline';await handler(e.interaction());assert.equal(e.replies.at(-1).files,undefined);assert.equal(e.sends.length,0);
});
test('Auto OFF committed while global Incident arbitration waits prevents the external punishment',async t=>{
 const f=await securityFixture(t);await f.change('auto:on');
 const security=createSecurityService({...f.coordinator,scoped:scope=>{const c=f.coordinator.scoped(scope);return{...c,update:async request=>{const chosen=await c.update(request);await f.change('auto:off');return chosen;}};}});
 const policy=(await f.security.read(guild)).value.data.policy;
 assert.equal(await security.claimAutomaticIncident(guild,incident,{emergencyStop:false,expectedPolicy:policy}),false);
});
