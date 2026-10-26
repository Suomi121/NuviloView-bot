import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveSpamPolicyAction } from '../lib/guild-spam-policy.mjs';
import { mayAutomaticallyTimeout, SECURITY_V2_TIMEOUT_MS } from '../lib/security-v2-consent.mjs';
import { timeoutFailureStatus } from '../lib/timeout-incidents.mjs';
import { incidentFixture, guildId, userId, channelId, messageId } from './helpers/timeout-incident-fixture.mjs';
import { securityFixture } from './helpers/quorum-fixture.mjs';
const bot=readFileSync(new URL('../discord-bot.mjs',import.meta.url),'utf8');
const source=bot.slice(bot.indexOf('async function handleSpamDetection'),bot.indexOf('async function replySpamComponentError'));
function harness(f,{apiError=null,protection=null,canTimeout=true,already=false,coordinatedSecurity=null,securityPolicy=null}={}){
  let timeouts=0,logs=0;
  const member={id:userId,user:{},moderatable:canTimeout,communicationDisabledUntilTimestamp:already?Date.now()+60000:null,
    timeout:async duration=>{timeouts++;assert.equal(duration,SECURITY_V2_TIMEOUT_MS);if(apiError)throw apiError;return {communicationDisabledUntilTimestamp:1790086400000};}};
  const sandbox={coordinatedSecurity,spamPolicyAuthority:{enabled:false},timeoutIncidents:f.incidents,timeoutFailureStatus,mayAutomaticallyTimeout,SECURITY_V2_TIMEOUT_MS,resolveSpamPolicyAction,
    process:{env:{SECURITY_V2_AUTO_EXECUTION:'enabled'}},sql:{query:async()=>({rows:[{migration_state:'complete',enabled:true,emergency_stop:false}]})},
    client:{user:{}},spamWindowMs:5000,PermissionFlagsBits:{ModerateMembers:1},getSpamProtectedReason:()=>protection,
    moderationAuditReason:()=>'',sendSpamDetectionAlert:async()=>{logs++;}};
  const run=vm.runInNewContext(source+'\nhandleSpamDetection',sandbox);
  const message={id:messageId,createdTimestamp:f.input.occurredAt,author:{id:userId},channelId,
    guild:{id:guildId,members:{fetch:async()=>member,fetchMe:async()=>({permissions:{has:()=>true}})}}};
  return {run:()=>run(message,{count:12,signals:['messages'],policyContext:{source:'default',policy:securityPolicy}}),counts:()=>({timeouts,logs})};
}
test('actual timeout path runs once on duplicate/concurrent delivery',async()=>{
  const f=incidentFixture();try{
    const h=harness(f);await Promise.all([h.run(),h.run(),h.run()]);
    assert.deepEqual(h.counts(),{timeouts:1,logs:1});
    const snapshot=f.incidents.snapshot(guildId,f.begin().incidentId);
    assert.equal(snapshot.timeout.status,'success');assert.equal(snapshot.timeout.payload.actualEndAt,1790086400000);
  }finally{f.storage.close();}
});
for(const [name,options,status] of [['forbidden',{apiError:{status:403,message:'secret'}},'failed'],
  ['lost API response',{apiError:new Error('secret')},'unknown'],['protected',{protection:'owner'},'skipped'],
  ['missing permission',{canTimeout:false},'skipped'],['already timed out',{already:true},'skipped']]){
  test(`actual timeout path: ${name}`,async()=>{
    const f=incidentFixture();try{
      const h=harness(f,options);await h.run();await h.run();assert.equal(h.counts().logs,0);
      assert.equal(h.counts().timeouts,options.apiError?1:0);
      const s=f.incidents.snapshot(guildId,f.begin().incidentId);assert.equal(s.timeout.status,status);
      assert.doesNotMatch(JSON.stringify(s),/secret/);
    }finally{f.storage.close();}
  });
}
test('failed local claim prevents Discord effects; post-API Audit failure never becomes timeout failure',async()=>{
  for(const failing of ['spam_detection','timeout_claim','timeout_api','timeout_result']){
    const f=incidentFixture({wrapAudit:a=>({...a,recordIncidentEvent(input){if(input.action===failing)throw new Error('isolated write failure');return a.recordIncidentEvent(input);}})});
    try{
      const h=harness(f);await assert.rejects(h.run(),/write failure/);
      assert.deepEqual(h.counts(),{timeouts:failing==='timeout_result'?1:0,logs:0});
      if(failing!=='spam_detection')await h.run();
      assert.equal(h.counts().timeouts,failing==='timeout_result'?1:0);
    }finally{f.storage.close();}
  }
});

for (const mode of ['single-outage', 'two-outages', 'off-before-api', 'emergency-before-api', 'stale-detection']) {
  test(`actual v2 timeout entry + real quorum SQL: ${mode}`, async t => {
    const q = await securityFixture(t), f = incidentFixture(); t.after(() => f.storage.close());
    await q.change('auto:on');
    const securityPolicy = (await q.security.read(guildId)).value.data.policy;
    if (mode === 'stale-detection') await q.change('level', 42);
    q.faults.neon = true;
    if (mode === 'two-outages') q.faults.supabase = true;
    let checks = 0;
    const coordinatedSecurity = { ...q.security, automaticAllowed: async (...args) => {
      if (++checks === 2 && mode === 'off-before-api') await q.change('auto:off');
      if (checks === 2 && mode === 'emergency-before-api') await q.change('emergency:on');
      return q.security.automaticAllowed(...args);
    } };
    const h = harness(f, { coordinatedSecurity, securityPolicy });
    await h.run(); await h.run();
    assert.equal(h.counts().timeouts, mode === 'single-outage' ? 1 : 0);
    assert.equal(h.counts().logs, mode === 'single-outage' ? 1 : 0);
  });
}
