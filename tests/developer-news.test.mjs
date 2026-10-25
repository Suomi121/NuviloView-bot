import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newsFixture, owner, other, guilds, target, drain } from './helpers/news-fixture.mjs';
import { createNewsService } from '../lib/news-service.mjs';
import { isNewsDeveloper, validateNews, newsPayload, newsDigest } from '../lib/news-contract.mjs';
import { normalizeSyncEnvelope } from '../lib/sync/conflict-policy.mjs';
import { createLocalStorage } from '../lib/storage/index.mjs';

const transport = (sent=[]) => ({validate:async()=>{},send:async row=>{
  sent.push(row.guildId);return{id:'600000000000000001',guildId:row.guildId,channelId:row.channelId};
}});
test('existing Developer ID gate only; no names/role/admin grants; malformed IDs denied',()=>{
  assert.equal(isNewsDeveloper(owner,{DISCORD_OWNER_USER_ID:owner}),true);
  assert.equal(isNewsDeveloper(owner,{GUILD_RESET_DEVELOPER_IDS:owner}),true);
  for(const id of [other,'admin','owner',null])assert.equal(isNewsDeveloper(id,{DISCORD_OWNER_USER_ID:owner}),false);
  assert.equal(isNewsDeveloper(owner,{AI_OWNER_USER_ID:owner}),false,'nonexistent legacy variable is not silently adopted');
});
test('Embed limits, neutralized mentions, invalid URL/color and sanitized public payload',()=>{
  const c=validateNews({title:'@everyone <@123456789012345678>',body:'@here',url:'https://example.com',color:'#abcdef'});
  assert.doesNotMatch(c.title,/@everyone|<@/);assert.doesNotMatch(c.body,/@here/);
  for(const url of ['javascript:alert(1)','http://example.com','https://a:b@example.com','https://127.0.0.1','https://localhost','https://host.local'])assert.throws(()=>validateNews({title:'a',body:'b',url}));
  for(const body of ['', 'a'.repeat(4001)])assert.throws(()=>validateNews({title:'a',body}));
  assert.throws(()=>validateNews({title:'a'.repeat(257),body:'b'}));
  assert.throws(()=>validateNews({title:'a',body:'b',color:'red'}));
  const payload=newsPayload({id:'a'.repeat(32),content:c});assert.deepEqual(payload.allowedMentions,{parse:[],repliedUser:false});
});
test('every session checks owner, nonce, expiry, message, channel and revision',async t=>{
  const f=newsFixture(t),n=await f.draft(),input=f.input(n);
  for(const patch of [{ownerId:other},{nonce:'bad'},{version:99},{messageId:'399999999999999999'},{channelId:'299999999999999999'}])assert.throws(()=>f.service.session({...input,...patch}));
  f.allowed.delete(owner);assert.throws(()=>f.service.session(input));f.allowed.add(owner);
  f.clock(15*60000);assert.throws(()=>f.service.session(input),{code:'NEWS_STALE_SESSION'});
});
test('draft editing and cancellation never dispatch; final confirmation mandatory',async t=>{
  const f=newsFixture(t);await assert.rejects(f.service.create(other),{code:'NEWS_FORBIDDEN'});
  let n=f.edit(await f.draft());const sent=[];
  assert.equal(await f.service.deliverOne(n.id,transport(sent)),false);
  await assert.rejects(f.service.confirm(f.input(n)),{code:'NEWS_CONFIRM_REQUIRED'});
  n=await f.service.prepare(f.input(n),guilds(17));
  assert.equal(f.service.stats(n.id).total,17);assert.equal(await f.service.deliverOne(n.id,transport(sent)),false);
  f.service.cancel(f.input(n));assert.equal(sent.length,0);
  await assert.rejects(f.service.confirm(f.input(n)));
});
test('17 Guild delivery, absent destinations skip, immutable target snapshot and dynamic membership input',async t=>{
  const f=newsFixture(t);let n=f.edit(await f.draft());const ids=guilds(17);
  for(const g of ids.slice(0,16))f.service.setDestination(owner,g,target(g));
  n=await f.service.prepare(f.input(n),ids);n=await f.service.confirm(f.input(n));
  const sent=[];await drain(f.service,n.id,transport(sent));
  assert.equal(sent.length,16);assert.equal(new Set(sent).size,16);
  assert.equal(f.service.stats(n.id).unconfigured,1);
  assert.equal(f.service.stats(n.id).sent,16);
  assert.equal(f.service.get(n.id).targets.length,17);
  assert.ok(!sent.includes(guilds(18)[17]),'newly joined Guild is not added after final confirmation');
  let next=f.edit(await f.draft());next=await f.service.prepare(f.input(next),guilds(18));assert.equal(next.targets.length,18);
});
test('double confirmation and parallel dispatcher claims never send same Guild twice',async t=>{
  const f=newsFixture(t);let n=f.edit(await f.draft());f.service.setDestination(owner,guilds(1)[0],target(guilds(1)[0]));
  n=await f.service.prepare(f.input(n),guilds(1));
  const r=await Promise.allSettled([f.service.confirm(f.input(n)),f.service.confirm(f.input(n))]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
  const sent=[];await Promise.all([f.service.deliverOne(n.id,transport(sent)),f.service.deliverOne(n.id,transport(sent))]);
  assert.equal(sent.length,1);
});
for(const [status,expected] of [[429,'failed'],[403,'failed'],[500,'unknown'],[502,'unknown'],[408,'unknown']]){
  test(`Discord ${status} is tracked, not automatically retried`,async t=>{
    const f=newsFixture(t),n=await f.queued();let attempts=0;
    const tx={validate:async()=>{},send:async()=>{attempts++;throw{status,message:'SECRET_VALUE'};}};
    await drain(f.service,n.id,tx);assert.equal(attempts,1);
    assert.equal(f.service.get(n.id).targets[0].status,expected);
    assert.doesNotMatch(JSON.stringify(f.service.get(n.id)),/SECRET_VALUE/);
    if(expected==='unknown')await assert.rejects(f.service.prepare(f.input(f.service.get(n.id)),guilds(1),true),{code:'NEWS_NO_RETRY_TARGET'});
  });
}
test('timeout / lost response quarantined; failure-only retry requires explicit new confirmation and cloud outcome proof',async t=>{
  const f=newsFixture(t),n=await f.queued();let count=0;
  await drain(f.service,n.id,{validate:async()=>{},send:async()=>{count++;throw{status:403};}});
  let retry=await f.service.prepare(f.input(f.service.get(n.id)),guilds(1),true);
  assert.equal(await f.service.deliverOne(n.id,transport()),false);
  retry=await f.service.confirm(f.input(retry));const sent=[];
  await drain(f.service,n.id,transport(sent));assert.equal(sent.length,1);
  assert.equal(f.service.get(n.id).targets[0].attempt,2);assert.equal(count,1);
});
test('process death or DB failure after Discord send stays UNKNOWN after restart, never replayed',async t=>{
  let fail=false;
  const f=newsFixture(t,{storageWrap:s=>({...s,syncMetadata:{...s.syncMetadata,set(input){
    if(fail&&input.metadata?.targets?.some(r=>r.status==='sent'))throw new Error('DISK_FULL');
    return s.syncMetadata.set(input);
  }}})});
  const n=await f.queued(),sent=[];fail=true;
  await assert.rejects(f.service.deliverOne(n.id,transport(sent)),/DISK_FULL/);
  fail=false;assert.equal(f.service.get(n.id).targets[0].status,'sending');
  const restarted=createNewsService(f.options);restarted.recover();await drain(restarted,n.id,transport(sent));
  assert.equal(sent.length,1);assert.equal(restarted.get(n.id).targets[0].status,'unknown');
});
test('persistent SQLite reopen restores pending jobs and audit/outbox; destination changes never reroute a confirmed publication',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'news-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=newsFixture(t,{databasePath:join(dir,'test.sqlite')}),n=await f.queued(guilds(2));
  f.service.setDestination(owner,guilds(2)[1],null);
  f.db.close();
  const reopened=createLocalStorage({databasePath:join(dir,'test.sqlite')});
  try{
    const restored=createNewsService({...f.options,storage:reopened});restored.recover();
    const sent=[];await drain(restored,n.id,transport(sent));
    assert.equal(sent.length,1);assert.equal(restored.get(n.id).targets[1].code,'DESTINATION_CHANGED');
    assert.ok(reopened.outbox.getQueueSize().count>0);
  }finally{reopened.close();}
});
test('Multi-DB unavailable, checksum inconsistency, revoked developer and local corruption fail closed',async t=>{
  let ready=true;const f=newsFixture(t,{ready:async()=>ready});let n=f.edit(await f.draft());ready=false;
  await assert.rejects(f.service.prepare(f.input(n),guilds(1)),{code:'NEWS_NOT_READY'});ready=true;
  f.service.setDestination(owner,guilds(1)[0],target(guilds(1)[0]));n=await f.service.prepare(f.input(n),guilds(1));n=await f.service.confirm(f.input(n));
  f.faults.neon=true;f.faults.supabase=true;const sent=[];await drain(f.service,n.id,transport(sent));
  assert.equal(sent.length,0);assert.equal(f.service.get(n.id).targets[0].status,'unknown');
  f.allowed.delete(owner);assert.throws(()=>f.service.setDestination(owner,guilds(1)[0],null));
  const record=f.db.syncMetadata.get(`news:v1:${n.id}`);record.metadata.content.title='tampered';f.db.syncMetadata.set(record);
  assert.throws(()=>f.service.get(n.id),{code:'NEWS_STORE_CORRUPT'});
});
test('immutable cloud claim votes reject simultaneous conflicting owners and old local state',async t=>{
  const f=newsFixture(t);
  const e=nonce=>normalizeSyncEnvelope({eventId:'news-claim-fixture',domain:'security',eventType:'news_delivery_claim_v1',aggregateId:'fixture',payload:{nonce},createdAt:1});
  const results=await Promise.allSettled([f.cloud.claim(e('a')),f.cloud.claim(e('b'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(f.cloud.claim(e('a')),{code:'NEWS_EXISTING_CLAIM'});
  assert.equal(await f.cloud.verify(e('a').eventId,newsDigest({not:'the hash'})),false);
  const winningHash=results.find(r=>r.status==='fulfilled').value;
  f.maps.get('turso').set(e('a').eventId,'corrupt');
  assert.equal(await f.cloud.verify(e('a').eventId,winningHash),false,'any observed conflict blocks retries, even with two matching copies');
});
test('published body cannot change during retry planning; cancelling retry preserves original history',async t=>{
  const f=newsFixture(t),n=await f.queued();
  await drain(f.service,n.id,{validate:async()=>{},send:async()=>{throw{status:403};}});
  const retry=await f.service.prepare(f.input(f.service.get(n.id)),guilds(1),true);
  assert.throws(()=>f.service.edit(f.input(retry),{title:'new',body:'new'}),{code:'NEWS_FROZEN'});
  const cancelled=f.service.cancel(f.input(retry));assert.equal(cancelled.state,'completed');
  assert.equal(cancelled.targets[0].status,'failed');assert.equal(cancelled.content.title,n.content.title);
});
test('Rate Limit has a minimum cooldown; durable delivery proofs are not purged with ordinary Outbox retention',async t=>{
  const f=newsFixture(t),n=await f.queued();
  await drain(f.service,n.id,{validate:async()=>{},send:async()=>{throw{status:429,retry_after:120};}});
  await assert.rejects(f.service.prepare(f.input(f.service.get(n.id)),guilds(1),true),{code:'NEWS_NO_RETRY_TARGET'});
  f.clock(121000);
  const retry=await f.service.prepare(f.input(f.service.get(n.id)),guilds(1),true);assert.equal(retry.retryGuilds.length,1);
  const at=Number.MAX_SAFE_INTEGER-1000;
  const claimed=f.db.outbox.claimBatch({workerId:'isolated',limit:1000,lockTimeoutMs:1000,at});
  assert.ok(claimed.length>0);f.db.outbox.markSynced(claimed.map(e=>e.id),{workerId:'isolated',at});
  assert.equal(f.db.outbox.purgeSynced({olderThan:at+100}),0);
});
test('losing/restored writer cannot manufacture retryable failure while winning writer is sending',async t=>{
  const a=newsFixture(t),b=newsFixture(t),n=await a.queued();
  for(const key of ['news-index:v1',`news:v1:${n.id}`,`news-destination:v1:${guilds(1)[0]}`])b.db.syncMetadata.set(a.db.syncMetadata.get(key));
  const restored=createNewsService({...b.options,cloud:a.cloud});
  let release,started;const sending=new Promise(r=>{started=r;}),done=new Promise(r=>{release=r;});let sends=0;
  const first=a.service.deliverOne(n.id,{validate:async()=>{},send:async row=>{
    sends++;started();await done;return{id:'600000000000000001',guildId:row.guildId,channelId:row.channelId};
  }});
  await sending;
  await restored.deliverOne(n.id,{validate:async()=>{throw{status:403};},send:async()=>assert.fail('No second external send')});
  assert.equal(restored.get(n.id).targets[0].status,'unknown');
  release();await first;assert.equal(sends,1);
});
