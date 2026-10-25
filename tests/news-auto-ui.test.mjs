import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoFixture,g,c1,at } from './helpers/news-auto-fixture.mjs';
import { guilds,owner,other,channel,message } from './helpers/news-fixture.mjs';
import { newsTargetsPage } from '../lib/news-discord.mjs';
import { createNewsActivityReader } from '../lib/news-activity-reader.mjs';

function interaction(n,action,{customId=null,user=owner,channelId=channel}={}){
 const replies=[],calls=[];return{replies,calls,customId:customId??`nvnews:${n.id}:${n.nonce}:${n.version}:${action}`,
  user:{id:user},guildId:null,channelId,message:{id:customId?'300000000000000009':message},isButton:()=>true,isModalSubmit:()=>false,
  deferReply:async()=>calls.push('ACK'),deferUpdate:async()=>calls.push('UPDATE_ACK'),
  editReply:async p=>replies.push(p),reply:async p=>{calls.push('REPLY');replies.push(p);}};
}
test('private destination pagination is complete and bounded; root session remains validated across page message IDs',async t=>{
 const f=autoFixture(t,{ids:guilds(19)}),n=await f.planned();
 const i=interaction(n,'targets0');await f.ui.interaction(i);assert.equal(i.calls[0],'ACK');assert.match(i.replies[0].content,/1\/3/);
 const next=i.replies[0].components[0].toJSON().components[1].custom_id;
 const page2=interaction(n,'',{customId:next});await f.ui.interaction(page2);
 assert.deepEqual(page2.calls,['UPDATE_ACK']);assert.match(page2.replies[0].content,/2\/3/);
 const all=[];for(let page=0;page<3;page++){
  const view=newsTargetsPage(n,page);assert.ok(view.content.length<2000);assert.deepEqual(view.allowedMentions,{parse:[]});
  all.push(...[...view.content.matchAll(/Guild (\d+) →/g)].map(m=>m[1]));
  assert.ok(view.components[0].toJSON().components.every(c=>c.custom_id.length<=100));
 }
 assert.equal(new Set(all).size,19);assert.equal(all.length,19);assert.equal(f.sends.length,0);
 const stale=interaction(n,'',{customId:next});f.service.cancel(f.input(n));await f.ui.interaction(stale);
 assert.doesNotMatch(stale.replies[0].content,/Guild \d+ →/);
});
test('pagination refuses outsider, wrong DM, forged confirmation suffix and out-of-range page',async t=>{
 const f=autoFixture(t),n=await f.planned();
 for(const i of [interaction(n,'targets0',{user:other}),interaction(n,'targets0',{channelId:'200000000000000009'}),
  interaction(n,'',{customId:`nvnews:${n.id}:${n.nonce}:${n.version}:confirm:${message}`}),interaction(n,'targets999')]){
  await f.ui.interaction(i);assert.doesNotMatch(i.replies[0].content,/Guild \d+ →/);
 }
 assert.equal(f.service.get(n.id).state,'confirming');assert.equal(f.sends.length,0);
 const max={...n,version:99999999,dmMessageId:'3000000000000000000001'};
 assert.ok(newsTargetsPage(max).components[0].toJSON().components.every(c=>c.custom_id.length<=100));
});
test('interaction ACK occurs before delayed candidate/statistics retrieval',async t=>{
 const f=autoFixture(t),n=await f.draft();let release;const gate=new Promise(r=>{release=r;});
 const fetch=f.guildMap.get(g).channels.fetch;f.guildMap.get(g).channels.fetch=async id=>{await gate;return fetch(id);};
 const i=interaction(n,'plan'),work=f.ui.interaction(i);await new Promise(r=>setImmediate(r));assert.deepEqual(i.calls,['ACK']);
 release();await work;assert.equal(f.service.get(n.id).state,'confirming');assert.equal(f.sends.length,0);
});
test('real read-only SQLite thread reuses the activity repository and does not mutate message metrics',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nv-news-activity-'));let f,reader;
 t.after(async()=>{await reader?.close();f?.db.close();rmSync(dir,{recursive:true,force:true});});
 f=autoFixture(t,{databasePath:join(dir,'fixture.sqlite')});f.addMessages(c1,3);
 const before=f.db.messageDomain.getMetrics();reader=createNewsActivityReader(f.db,{timeoutMs:5000});
 const result=await reader.read(g,{at});assert.equal(result.channels[0].messages,3);assert.deepEqual(f.db.messageDomain.getMetrics(),before);
});
test('statistics worker timeout/failure is bounded, credential-free and falls back instead of blocking Discord',async()=>{
 let created=0,terminated=0,workerOptions;
 class Stalled extends EventEmitter{postMessage(){}terminate(){terminated++;return Promise.resolve();}}
 const reader=createNewsActivityReader({health:{getDatabasePath:()=>'/isolated/synthetic.sqlite'}},{timeoutMs:20,
  workerFactory:options=>{created++;workerOptions=options;return new Stalled();}});
 try{
  const waiting=[reader.read(g,{at}),reader.read(g,{at}),reader.read(g,{at})];
  assert.equal(await reader.read(g,{at}),null);assert.deepEqual(await Promise.all(waiting),[null,null,null]);
  assert.equal(created,1);assert.equal(terminated,1);assert.deepEqual(workerOptions.env,{});assert.equal(await reader.read(g,{at}),null);
 }finally{await reader.close();}
});
