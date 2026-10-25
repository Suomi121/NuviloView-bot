import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType,PermissionFlagsBits as P } from 'discord.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoFixture,g,c1,c2,at } from './helpers/news-auto-fixture.mjs';
import { owner,other,guilds,drain } from './helpers/news-fixture.mjs';
import { fixture } from './helpers/coordinator-fixture.mjs';
import { createQuorumNewsControl } from '../lib/multi-db/news-control.mjs';
import { newsScreen,newsTargetsPage } from '../lib/news-discord.mjs';

test('explicit destination wins even when another channel is more active',async t=>{
 const f=autoFixture(t);f.addMessages(c2,12);await f.service.setDestination(owner,g,c1);
 const n=await f.planned();assert.equal(n.targets[0].channelId,c1);assert.equal(n.targets[0].selection.mode,'explicit');
});
test('SQLite indexed seven-day human creates determine activity, not names/types/edits/other Guild',async t=>{
 const f=autoFixture(t,{definitions:[{id:c1,type:ChannelType.GuildAnnouncement},{id:c2,type:ChannelType.GuildVoice}]});
 f.addMessages(c1,2);f.addMessages(c2,4);f.addMessages(c1,30,{bot:true});f.addMessages(c1,30,{webhook:true});
 f.addMessages(c1,30,{unknown:true});f.addMessages(c1,30,{age:8*86400_000});f.addMessages(c1,30,{guildId:'400000000000000009'});
 const report=f.db.messageDomain.getChannelMessageActivity(g,{at});
 assert.deepEqual(report.channels.map(c=>[c.channelId,c.messages]),[[c1,2],[c2,4]]);
 assert.doesNotMatch(JSON.stringify(report),/synthetic-not-returned|authorId|username/);
 const n=await f.planned();assert.equal(n.targets[0].channelId,c2);assert.equal(n.targets[0].selection.mode,'activity');
 assert.equal(n.targets[0].selection.activity.messages,4);assert.equal(n.targets[0].selection.activity.coverage,'OBSERVED_LOCAL_ONLY');
});
test('same activity count uses stable numeric Channel ID order, not channel order',async t=>{
 const f=autoFixture(t,{definitions:[{id:c2},{id:c1}]});f.addMessages(c1,2);f.addMessages(c2,2);
 assert.equal((await f.planned()).targets[0].channelId,c1);
});
for(const mode of ['no data','all zero','read failure','stale','wrong Guild','wrong window'])test(`${mode}: fallback chooses a sendable channel without name/purpose preference`,async t=>{
 let raw=null;
 if(mode==='all zero')raw={guildId:g,windowStart:at-7*86400_000,windowEnd:at,generatedAt:at,channels:[{channelId:c2,messages:0,firstMessageAt:at-1000,lastMessageAt:at-1000,lastRecordedAt:at}]};
 if(mode==='wrong Guild')raw={guildId:'400000000000000009',windowStart:at-7*86400_000,windowEnd:at,generatedAt:at,channels:[]};
 if(mode==='wrong window')raw={guildId:g,windowStart:0,windowEnd:at,generatedAt:at,channels:[]};
 const f=autoFixture(t,{definitions:[{id:c2},{id:c1,type:ChannelType.GuildVoice}],
  activity:mode==='stale'?null:()=>{if(mode==='read failure')throw Error('PRIVATE_DB_URL');return raw;},storageAt:mode==='stale'?at-2*86400_000:at});
 if(mode==='stale')f.addMessages(c2,15,{age:3*86400_000});
 const row=(await f.planned()).targets[0];assert.equal(row.channelId,c1);assert.equal(row.selection.mode,'fallback');
 assert.doesNotMatch(JSON.stringify(row),/PRIVATE_DB_URL/);
});
test('one sendable channel, no ReadMessageHistory: fallback and delivery still possible',async t=>{
 const f=autoFixture(t,{definitions:[{id:c1,sendable:false},{id:c2}]});const n=await f.queued();
 assert.equal(n.targets[0].channelId,c2);await drain(f.service,n.id,f.ui.transport);
 assert.equal(f.sends.length,1);assert.deepEqual(f.historyReads,[]);assert.deepEqual(f.sends[0].payload.allowedMentions,{parse:[],repliedUser:false});
});
test('zero sendable channels is distinguished from inventory errors, never pretends a send succeeded',async t=>{
 const f=autoFixture(t,{definitions:[{id:c1,sendable:false},{id:c2,sendable:false}]});const n=await f.queued();
 assert.equal(n.targets[0].selection.reason,'NO_SENDABLE_CHANNEL');await drain(f.service,n.id,f.ui.transport);
 assert.equal(f.sends.length,0);assert.equal(f.service.stats(n.id).unavailable,1);
 const d=autoFixture(t);d.faults[g]='channels';const row=(await d.planned()).targets[0];
 assert.equal(row.selection.reason,'CHANNEL_DISCOVERY_FAILED');assert.notEqual(row.selection.reason,'NO_SENDABLE_CHANNEL');
});
test('active but unsendable channel is excluded; explicit invalid destination is disclosed before confirmation',async t=>{
 const f=autoFixture(t,{definitions:[{id:c1,sendable:false},{id:c2}]});f.addMessages(c1,20);f.addMessages(c2,2);
 await f.service.setDestination(owner,g,c1);const n=await f.planned();
 assert.equal(n.targets[0].channelId,c2);assert.equal(n.targets[0].selection.mode,'activity');
 assert.equal(n.targets[0].selection.explicitUnavailable,'EXPLICIT_DESTINATION_UNAVAILABLE');
 assert.match(newsTargetsPage(n).content,/明示先は送信不能/);assert.equal(f.service.destination(g).channelId,c1,'no Guild configuration mutation');
});
for(const failure of ['deleted','permission revoked'])test(`${failure} after confirmation: do not choose another destination`,async t=>{
 const f=autoFixture(t),n=await f.queued();const channels=await f.guildMap.get(g).channels.fetch();
 if(failure==='deleted'){
  const fetch=f.guildMap.get(g).channels.fetch;f.guildMap.get(g).channels.fetch=async id=>id===c1?null:fetch(id);
 }else channels.get(c1).permissions.delete(P.SendMessages);
 await drain(f.service,n.id,f.ui.transport);assert.equal(f.sends.length,0);assert.equal(f.service.get(n.id).targets[0].channelId,c1);
 assert.ok(['NEWS_CHANNEL','NEWS_PERMISSION'].includes(f.service.get(n.id).targets[0].code));
});
test('active threads participate by count; archived threads are not reopened, no thread purpose priority',async t=>{
 const f=autoFixture(t,{definitions:[{id:c1},{id:c2,type:ChannelType.PublicThread}]});f.addMessages(c2,3);
 assert.equal((await f.planned()).targets[0].channelId,c2);
 const h=autoFixture(t,{definitions:[{id:c1},{id:c2,type:ChannelType.PublicThread,archived:true}]});h.addMessages(c2,30);
 assert.equal((await h.planned()).targets[0].channelId,c1);
});
test('17 synthetic Guilds, actual membership growth/shrink and frozen targets, no hardcoded Guild count',async t=>{
 const ids=guilds(18),f=autoFixture(t,{ids:ids.slice(0,17)});let n=await f.planned();
 assert.equal(n.targets.length,17);assert.ok(n.targets.every(r=>r.selection.mode==='fallback'));
 assert.match(newsScreen(n,f.service.stats(n.id)).content,/配信可能17/);
 f.guildMap.delete(ids[0]);f.guildMap.set(ids[17],{id:ids[17]});n=await f.service.confirm(f.input(n));
 await drain(f.service,n.id,f.ui.transport);assert.equal(f.sends.length,16);assert.equal(new Set(f.sends.map(s=>s.guildId)).size,16);
 assert.ok(!f.sends.some(s=>s.guildId===ids[17]));assert.equal(f.service.get(n.id).targets[0].status,'skipped');
});
for(const status of [403,429,500])test(`Discord ${status}: accurate outcome, no fallback or blind retry`,async t=>{
 const f=autoFixture(t),n=await f.queued();f.faults[g]={status};await drain(f.service,n.id,f.ui.transport);
 assert.equal(f.service.get(n.id).targets[0].status,status===500?'unknown':'failed');
 await drain(f.service,n.id,f.ui.transport);assert.equal(f.sends.length,0);
 assert.equal(f.service.get(n.id).targets[0].channelId,c1);
 if(status===500)await assert.rejects(f.service.prepare(f.input(f.service.get(n.id)),[g],true),{code:'NEWS_NO_RETRY_TARGET'});
});
test('Neon outage: initialized Supabase/Turso quorum prepares all automatic destinations, claims once, denies loss of second vote',async t=>{
 const q=fixture(t);q.faults.neon='offline';const control=createQuorumNewsControl(q.c);
 const f=autoFixture(t,{destinationControl:control,cloud:control});const n=await f.queued();
 assert.equal(n.targets[0].selection.mode,'fallback');assert.equal(n.targets[0].destinationEpoch,q.c.epoch);
 await drain(f.service,n.id,f.ui.transport);await drain(f.service,n.id,f.ui.transport);assert.equal(f.sends.length,1);
 const b=autoFixture(t,{destinationControl:control,cloud:control});q.faults.supabase='offline';
 await assert.rejects(b.planned());assert.equal(b.sends.length,0);
});
test('restart preserves chosen destinations, sent proof and UNKNOWN; no re-ranking or duplicate send',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nv-news-auto-'));let f,restart;
 t.after(()=>{f?.db.close();restart?.db.close();rmSync(dir,{recursive:true,force:true});});
 const databasePath=join(dir,'test.sqlite');f=autoFixture(t,{databasePath});const n=await f.queued();await drain(f.service,n.id,f.ui.transport);
 restart=autoFixture(t,{databasePath});restart.addMessages(c2,40);await drain(restart.service,n.id,restart.ui.transport);
 assert.equal(restart.sends.length,0);assert.equal(restart.service.get(n.id).targets[0].channelId,c1);assert.equal(restart.service.stats(n.id).sent,1);
 const crash=autoFixture(t),queued=await crash.queued();
 await crash.service.deliverOne(queued.id,{validate:crash.ui.transport.validate,send:async()=>{throw Error('LOST_RESPONSE');}});
 crash.service.recover();assert.equal(crash.service.get(queued.id).targets[0].status,'unknown');assert.equal(crash.sends.length,0);
});
test('cross-Guild/DM channels and missing View/Embed permission are not eligible candidates',async t=>{
 const f=autoFixture(t),channels=await f.guildMap.get(g).channels.fetch();
 channels.get(c1).guildId='400000000000000009';assert.equal((await f.selector(g)).channelId,c2);
 channels.get(c1).guildId=g;channels.get(c1).isDMBased=()=>true;channels.get(c2).permissions.delete(P.EmbedLinks);
 assert.equal((await f.selector(g)).channelId,null);
 channels.get(c1).isDMBased=()=>false;channels.get(c1).permissions.delete(P.ViewChannel);assert.equal((await f.selector(g)).channelId,null);
});
test('seven-day window is inclusive only in range; duplicate message identity counted once, not edited again',t=>{
 const f=autoFixture(t);f.addMessages(c1,1,{age:7*86400_000});f.addMessages(c1,2,{age:7*86400_000+1});f.addMessages(c2,2,{age:-1});
 const original=f.db.messageDomain.getEventById(`message-create:${g}:900000000000000001`);
 assert.ok(original);f.db.messageDomain.recordEvent({...original,eventId:'synthetic-duplicate-create'});
 f.db.messageDomain.recordEvent({...original,eventId:'synthetic-update',eventType:'update',revision:'synthetic-update',sourceSequence:at,occurredAt:at});
 assert.deepEqual(f.db.messageDomain.getChannelMessageActivity(g,{at}).channels.map(r=>[r.channelId,r.messages]),[[c1,1]]);
});
test('unapproved sender cannot plan, final confirm required, selected destinations cannot mutate after approval',async t=>{
 const f=autoFixture(t),draft=await f.draft();await assert.rejects(f.service.prepare({...f.input(draft),ownerId:other},[g]));
 assert.equal(await f.service.deliverOne(draft.id,f.ui.transport),false);assert.equal(f.sends.length,0);
 const plan=await f.service.prepare(f.input(draft),[g]);f.addMessages(c2,30);
 const queued=await f.service.confirm(f.input(plan));await drain(f.service,queued.id,f.ui.transport);assert.equal(f.sends[0].channelId,c1);
});
test('explicit configuration changed during review invalidates the old unpublished plan and requires re-planning',async t=>{
 const f=autoFixture(t),n=await f.planned();await f.service.setDestination(owner,g,c2,f.input(n));
 const current=f.service.get(n.id);assert.equal(current.state,'draft');assert.equal(current.targets.length,0);
 await assert.rejects(f.service.confirm(f.input(current)),{code:'NEWS_CONFIRM_REQUIRED'});
 const reviewed=await f.service.prepare(f.input(current),[g]);assert.equal(reviewed.targets[0].channelId,c2);assert.equal(reviewed.targets[0].selection.mode,'explicit');
});
test('unmigrated legacy destination is not interpreted as quorum-unconfigured and silently replaced by fallback',async t=>{
 const q=fixture(t),control=createQuorumNewsControl(q.c),f=autoFixture(t,{destinationControl:control,cloud:control});
 f.db.syncMetadata.set({streamName:`news-destination:v1:${g}`,state:'active',metadata:{guildId:g,channelId:c2,revision:4}});
 await assert.rejects(f.planned(),{code:'NEWS_DESTINATION_MIGRATION_REQUIRED'});assert.equal(f.sends.length,0);
});
