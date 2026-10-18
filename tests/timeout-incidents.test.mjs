import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendTimeoutIncidentLog, timeoutLogPayload, formatTimeoutDuration } from '../lib/timeout-discord-log.mjs';
import { incidentFixture, guildId, userId, channelId, messageId } from './helpers/timeout-incident-fixture.mjs';
import { createSecurityAuditService } from '../lib/security-local-first.mjs';
import { createTimeoutIncidentService, timeoutIncidentId } from '../lib/timeout-incidents.mjs';

function logFixture(f, { configured=null, sendError=null, editError=false, permissions=true, deleted=false, configFailure=false, foreign=false }={}) {
  const sends=[],edits=[],fetches=[];
  const selected=configured??channelId;
  const guild={id:guildId, members:{fetchMe:async()=>({})},channels:{fetch:async(id,options)=>{
    fetches.push([id,options]);
    return deleted?null:{id,guildId:foreign?'other':guildId,isTextBased:()=>true,isThread:()=>false,
      permissionsFor:()=>({has:()=>permissions}),send:async payload=>{
        sends.push(payload); if(sendError) throw sendError;
        return {id:messageId,channelId:id,guildId,edit:async p=>{edits.push(p);if(editError)throw new Error('private provider error');}};
      }};
  }}};
  const run=()=>sendTimeoutIncidentLog({incidents:f.incidents,query:async()=>{
    if(configFailure)throw new Error('secret connection string');
    return {rows:configured?[{channel_id:configured}]:[]};
  },guild,incidentId:f.id,targetMember:{displayName:'**@everyone** <@123>',user:{username:'@here'}}});
  return {run,sends,edits,fetches,selected};
}
function completed(options) {
  const f=incidentFixture(options);f.id=f.begin().incidentId;
  assert.equal(f.incidents.claimTimeout(guildId,f.id),true);
  f.incidents.timeoutApi(guildId,f.id,86400_000);
  f.incidents.timeoutResult(guildId,f.id,'success',null,1790086400000);
  return f;
}
for(const configured of [null,'400000000000000002']) test(`log routes once to ${configured?'dedicated':'detection'} channel, then confirms delivery`,async()=>{
  const f=completed();try{
    const l=logFixture(f,{configured});await Promise.all([l.run(),l.run()]);
    assert.equal(l.sends.length,1);assert.equal(l.edits.length,1);
    assert.equal(l.fetches[0][0],l.selected);assert.equal(l.fetches[0][1].force,true);
    const before=l.sends[0].embeds[0].toJSON(),after=l.edits[0].embeds[0].toJSON();
    assert.doesNotMatch(before.fields[0].value,/送信された/);
    assert.match(after.fields[0].value,new RegExp(`<#${l.selected}> に送信されたよ`));
    assert.match(after.fields[0].value,/<t:1790000000:F>（<t:1790000000:R>）/);
    assert.match(after.fields[0].value,new RegExp(`<@${userId}> をスパム検知で1日タイムアウトしたよ`));
    assert.doesNotMatch(after.fields[1].value,/@everyone|@here|<@123>/);
    assert.deepEqual(l.sends[0].allowedMentions,{parse:[],repliedUser:false});
    assert.equal(l.sends[0].enforceNonce,true);assert.ok(l.sends[0].nonce.length<=25);
    assert.equal(l.sends[0].components,undefined);assert.equal(l.sends[0].files,undefined);
    const snapshot=f.incidents.snapshot(guildId,f.id);
    assert.equal(snapshot.log.status,'sent');assert.equal(snapshot.sent.payload.messageId,messageId);
    assert.equal(snapshot.timeout.payload.actualEndAt,1790086400000);
  }finally{f.storage.close();}
});
for(const [name,options,expected] of [
  ['missing configured channel',{configured:'400000000000000002',deleted:true},'LOG_CHANNEL_UNAVAILABLE'],
  ['missing permissions',{permissions:false},'LOG_PERMISSION_DENIED'],
  ['foreign channel',{foreign:true},'LOG_PERMISSION_DENIED'],
  ['DB unavailable',{configFailure:true},'LOG_CONFIG_UNAVAILABLE'],
  ['send forbidden',{sendError:{status:403,message:'secret'}},'DISCORD_FORBIDDEN'],
  ['send lost response',{sendError:new Error('secret raw response')},'DISCORD_API_ERROR'],
]) test(`${name}: no reroute, safe audit retained`,async()=>{
  const f=completed();try{
    const l=logFixture(f,options);await l.run();await l.run();
    assert.ok(l.fetches.length<=1);assert.ok(l.sends.length<=1);assert.equal(l.edits.length,0);
    const s=f.incidents.snapshot(guildId,f.id);assert.equal(s.timeout.status,'success');
    assert.equal(s.log.payload.errorCode,expected);assert.doesNotMatch(JSON.stringify(s),/secret|raw response/);
    if(options.sendError instanceof Error)assert.equal(s.log.status,'unknown');
  }finally{f.storage.close();}
});
test('edit failure preserves actual delivery and never adds a second message',async()=>{
  const f=completed();try{
    const l=logFixture(f,{editError:true});await l.run();await l.run();
    assert.equal(l.sends.length,1);assert.equal(l.edits.length,1);
    assert.equal(f.incidents.snapshot(guildId,f.id).log.status,'sent_edit_failed');
    assert.doesNotMatch(l.sends[0].embeds[0].toJSON().fields[0].value,/送信された/);
  }finally{f.storage.close();}
});
test('failed/skipped/unknown/pending timeouts never claim log or render a success',async()=>{
  for(const status of ['failed','skipped','unknown',null]){
    const f=incidentFixture();try{
      f.id=f.begin().incidentId;if(status)f.incidents.timeoutResult(guildId,f.id,status);
      const l=logFixture(f);await l.run();assert.equal(l.sends.length,0);
      assert.throws(()=>timeoutLogPayload(f.incidents.snapshot(guildId,f.id),{}),/TIMEOUT_NOT_CONFIRMED/);
    }finally{f.storage.close();}
  }
});
test('unknown user fields are explicit and duration reflects actual input',()=>{
  const f=completed();try{
    const p=timeoutLogPayload(f.incidents.snapshot(guildId,f.id),null).embeds[0].toJSON();
    assert.match(p.fields[1].value,/表示名: 取得できません\nユーザー名: 取得できません/);
    assert.equal(formatTimeoutDuration(7200_000),'2時間');assert.equal(formatTimeoutDuration(90_000),'90秒');
    assert.throws(()=>f.incidents.snapshot('100000000000000002',f.id),/NOT_FOUND/);
  }finally{f.storage.close();}
});
test('incident/timeout/log claims survive SQLite restart and redelivery',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'nuviloview-prb-'));
  const databasePath=join(directory,'isolated.sqlite');
  try{
    let f=completed({databasePath});const id=f.id;
    assert.equal(f.incidents.claimLog(guildId,id),true);f.storage.close();
    f=incidentFixture({databasePath});f.id=id;
    try{
      assert.equal(f.begin().inserted,false);assert.equal(f.incidents.claimTimeout(guildId,id),false);
      const l=logFixture(f);await l.run();assert.equal(l.sends.length,0);
      assert.equal(f.incidents.snapshot(guildId,id).logClaim.status,'pending');
    }finally{f.storage.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('privacy: incident stores only allow-listed evidence',()=>{
  const f=incidentFixture();try{
    const i=f.incidents.begin({...f.input,rawMessage:'private content',signals:['messages','secret data'],botToken:'secret'});
    assert.deepEqual(i.payload.rules,['messages']);assert.doesNotMatch(JSON.stringify(i),/private content|secret data|botToken/);
    assert.equal(f.incidents.begin({...f.input,messageId:'500000000000000002'}).inserted,true);
  }finally{f.storage.close();}
});
test('Audit and existing security Outbox are one transaction',()=>{
  const f=incidentFixture();try{
    const audit=createSecurityAuditService({storage:{...f.storage,outbox:{enqueue(){throw new Error('isolated outbox unavailable');}}}});
    const incidents=createTimeoutIncidentService({audit});
    assert.throws(()=>incidents.begin(f.input),/outbox unavailable/);
    assert.equal(f.audit.getModerationAudit(timeoutIncidentId(guildId,userId,messageId)),null);
    assert.equal(f.begin().inserted,true);
  }finally{f.storage.close();}
});
test('post-send storage failure and post-send restart never cause another Discord send',async()=>{
  for(const failing of ['log_sent','log_result']){
    let fail=true;
    const f=completed({wrapAudit:a=>({...a,recordIncidentEvent(input){
      if(fail&&input.action===failing)throw new Error('isolated persistence failure');
      return a.recordIncidentEvent(input);
    }})});
    try{
      const l=logFixture(f);await assert.rejects(l.run(),/persistence failure/);
      fail=false;await l.run();assert.equal(l.sends.length,1);
      const s=f.incidents.snapshot(guildId,f.id);
      assert.equal(s.timeout.status,'success');
      assert.equal(s.logState,failing==='log_sent'?'pending_or_unknown':'sent_confirmation_pending');
    }finally{f.storage.close();}
  }
});
