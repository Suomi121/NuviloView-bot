import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { createNewsDiscord, newsScreen, liveNewsGuildIds } from '../lib/news-discord.mjs';
import { newsHealthReady, createNewsRuntime } from '../lib/news-runtime.mjs';
import { newsFixture, owner, other, channel, message, guilds, target } from './helpers/news-fixture.mjs';

function discordFixture(t) {
  const f=newsFixture(t), g=guilds(1)[0], sent=[], edited=[];
  let permission=true, joined=true, wrongChannel=false, history=[];
  const ch={id:target(g),guildId:g,type:ChannelType.GuildText,permissionsFor:()=>({has:()=>permission}),messages:{fetch:async()=>({some:fn=>history.some(fn)})},send:async p=>{
    sent.push(p);return{id:'600000000000000001',channelId:target(g),guildId:g};
  }};
  const guild={id:g,roles:{fetch:async()=>new Map()},channels:{fetch:async()=>wrongChannel?{...ch,guildId:guilds(2)[1]}:ch},members:{fetchMe:async()=>({id:'700000000000000001',guild})}};
  const dm={id:channel,send:async p=>({id:message,edit:async p=>edited.push(p)}),messages:{edit:async(id,p)=>edited.push(p)}};
  const author={id:owner,bot:false,createDM:async()=>dm,send:async()=>{}};
  const client={user:{id:'700000000000000001'},users:{fetch:async()=>author},guilds:{fetch:async id=>typeof id==='string'?guild:new Map(joined?[[g,guild]]:[])}};
  const ui=createNewsDiscord({service:f.service,client,isDeveloper:id=>f.allowed.has(id),allow:()=>true});
  const interaction=(n,action,{user=owner,modal=false,fields={}}={})=>{
    const calls=[],replies=[];
    return{calls,replies,customId:`nvnews:${n.id}:${n.nonce}:${n.version}:${action}`,user:{id:user},guildId:null,channelId:channel,message:{id:message},
      isButton:()=>!modal,isModalSubmit:()=>modal,fields:{getTextInputValue:k=>fields[k]??''},
      showModal:async m=>{calls.push('MODAL');replies.push(m.toJSON());},
      deferReply:async()=>calls.push('ACK'),reply:async p=>{calls.push('REPLY');replies.push(p);},editReply:async p=>{calls.push('EDIT');replies.push(p);},followUp:async p=>replies.push(p)};
  };
  return{...f,ui,client,author,edited,sent,interaction,g,ch,setPermission:v=>{permission=v;},setJoined:v=>{joined=v;},setWrong:v=>{wrongChannel=v;},setHistory:v=>{history=v;}};
}

test('prefix UI goes only to developer DM; unauthorized prefix remains visible to normal spam tracking',async t=>{
  const f=discordFixture(t);
  assert.equal(await f.ui.message({content:'s?news',author:{id:other,bot:false}}),false);
  assert.equal(await f.ui.message({content:'r?help',author:f.author}),false);
  await f.ui.message({content:'s?news',author:f.author,channel:{send:()=>assert.fail('No public draft')}});
  const n=f.service.list()[0];assert.equal(n.dmChannelId,channel);
  const labels=f.edited[0].components[0].toJSON().components.map(c=>c.label);
  assert.deepEqual(labels,['内容を編集','プレビュー','全Guildに送信','キャンセル']);
});
test('real Button/Modal builders and handlers edit the private Embed; old modal cannot be replayed',async t=>{
  const f=discordFixture(t);const n=await f.draft();
  const open=f.interaction(n,'edit');await f.ui.interaction(open);
  assert.deepEqual(open.calls,['MODAL']);assert.equal(open.replies[0].components.length,4);
  const modal=f.interaction(n,'save',{modal:true,fields:{title:'新機能',body:'合成本文',url:'https://example.com',color:'#123abc'}});
  await f.ui.interaction(modal);assert.equal(modal.calls[0],'ACK');
  assert.equal(f.service.get(n.id).content.title,'新機能');assert.equal(f.edited.at(-1).embeds[0].title,'新機能');
  const stale=f.interaction(n,'save',{modal:true,fields:{title:'replay',body:'replay'}});await f.ui.interaction(stale);
  assert.doesNotMatch(stale.replies[0].content,/更新した/);assert.equal(f.service.get(n.id).content.title,'新機能');
});
test('outsider, Guild-context forged buttons, wrong message and rate-limited session never execute',async t=>{
  const f=discordFixture(t),n=await f.draft();
  for(const modify of [i=>{i.user.id=other;},i=>{i.guildId=f.g;},i=>{i.message.id='999999999999999999';}]){
    const i=f.interaction(n,'plan');modify(i);await f.ui.interaction(i);assert.doesNotMatch(i.replies[0].content,/更新した/);
  }
  const rate=createNewsDiscord({service:f.service,client:f.client,isDeveloper:()=>true,allow:()=>false});
  const i=f.interaction(n,'plan');await rate.interaction(i);assert.match(i.replies[0].content,/待って/);
  assert.equal(f.service.get(n.id).state,'draft');
});
test('final confirmation previews current Guild count and requires a distinct confirm action',async t=>{
  const f=discordFixture(t);let n=f.edit(await f.draft());f.service.setDestination(owner,f.g,target(f.g));
  await f.ui.interaction(f.interaction(n,'plan'));n=f.service.get(n.id);
  assert.equal(n.state,'confirming');assert.equal(f.sent.length,0);
  assert.match(newsScreen(n,f.service.stats(n.id)).content,/最終確認/);
  await f.ui.interaction(f.interaction(n,'confirm'));assert.equal(f.service.get(n.id).state,'queued');
  await f.service.deliverOne(n.id,f.ui.transport);assert.equal(f.sent.length,1);
  assert.deepEqual(f.sent[0].allowedMentions,{parse:[],repliedUser:false});
});
test('destination management checks Developer, actual membership, Guild/channel match and permissions; consumes modal revision',async t=>{
  const f=discordFixture(t);let n=await f.draft();
  const make=()=>f.interaction(n,'setdest',{modal:true,fields:{guild:f.g,channel:target(f.g)}});
  f.setWrong(true);await f.ui.interaction(make());assert.equal(f.service.destination(f.g).channelId,null);
  f.setWrong(false);f.setPermission(false);await f.ui.interaction(make());assert.equal(f.service.destination(f.g).channelId,null);
  f.setPermission(true);await f.ui.interaction(make());assert.equal(f.service.destination(f.g).channelId,target(f.g));
  const revision=f.service.destination(f.g).revision;await f.ui.interaction(make());assert.equal(f.service.destination(f.g).revision,revision);
  n=f.service.get(n.id);await f.ui.interaction(f.interaction(n,'setdest',{modal:true,fields:{guild:f.g,channel:'off'}}));
  assert.equal(f.service.destination(f.g).channelId,null);
});
test('delivery rechecks membership and permissions; duplicate history stops send without fallback',async t=>{
  const f=discordFixture(t),n=await f.queued();const row=n.targets[0];
  f.setJoined(false);await assert.rejects(f.ui.transport.validate(row,n),{code:'NEWS_NOT_JOINED'});
  f.setJoined(true);f.setPermission(false);await assert.rejects(f.ui.transport.validate(row,n),{code:'NEWS_PERMISSION'});
  f.setPermission(true);f.setHistory([{author:{id:f.client.user.id},embeds:[{footer:{text:`NuviloView News · ${n.id}`}}]}]);
  await assert.rejects(f.ui.transport.validate(row,n),{code:'NEWS_DUPLICATE'});assert.equal(f.sent.length,0);
});
test('prefix DM failure does not leak a draft publicly or permanently strand an unbound draft',async t=>{
  const f=discordFixture(t),author={...f.author,createDM:async()=>{throw new Error('DM blocked');}};
  await f.ui.message({content:'s?news',author});assert.equal(f.service.list()[0].state,'cancelled');
  assert.equal(f.edited.length,0);
});
test('health gate rejects stale metrics, corruption, Worker stop, required-provider degradation and DLQ',t=>{
  const f=newsFixture(t),at=Date.now();
  const local=[{enabled:true,required:true,healthStatus:'HEALTHY',deadLetter:0}];
  const storage={...f.db,providerDeliveries:{...f.db.providerDeliveries,getAllProviderStatus:()=>local}};
  const base={mode:'MULTI_DB_SYNC_V1',workerStatus:'RUNNING',workerHealth:'HEALTHY',generatedAt:at,
    sqlite:{status:'HEALTHY',integrity:{ok:true}},providers:{supabase:{enabled:true,required:true,healthStatus:'HEALTHY'},turso:{enabled:true,required:true,healthStatus:'HEALTHY'}}};
  assert.equal(newsHealthReady({storage,snapshot:base,now:at}),true);
  for(const patch of [{generatedAt:at-90001},{generatedAt:at+1},{workerStatus:'OFFLINE'},{workerHealth:'DEGRADED'},{sqlite:{status:'UNHEALTHY'}},{providers:{}}])assert.equal(newsHealthReady({storage,snapshot:{...base,...patch},now:at}),false);
  local[0].deadLetter=1;assert.equal(newsHealthReady({storage,snapshot:base,now:at}),false);
  local[0].deadLetter=0;local[0].healthStatus='DEGRADED';assert.equal(newsHealthReady({storage,snapshot:base,now:at}),false);
  assert.equal(newsHealthReady({storage:{...storage,health:{checkIntegrity:()=>({ok:false})}},snapshot:base,now:at}),false);
});
test('feature defaults disabled and never initializes a production sender',async()=>{
  const runtime=await createNewsRuntime({env:{},storage:null,client:null});assert.equal(runtime.enabled,false);
  assert.equal(await runtime.message({content:'s?news',author:{id:other,bot:false}}),false);
  await runtime.stop();
});
test('live Guild inventory paginates past 200 and refuses non-progressing or invalid pages',async()=>{
  const ids=guilds(201),calls=[];
  const client={guilds:{fetch:async options=>{calls.push(options);return new Map((options.after?ids.slice(200):ids.slice(0,200)).map(id=>[id,{}]));}}};
  assert.equal((await liveNewsGuildIds(client)).size,201);assert.equal(calls[1].after,ids[199]);
  await assert.rejects(liveNewsGuildIds({guilds:{fetch:async()=>new Map(ids.slice(0,200).map(id=>[id,{}]))}}),{code:'NEWS_GUILD_INVENTORY'});
});
test('Modal initial ACK does not wait for SQLite; form cache never grants submit/send rights',async t=>{
  const f=discordFixture(t),n=await f.draft();
  const ui=createNewsDiscord({client:f.client,isDeveloper:id=>id===owner,allow:()=>true,
    service:{...f.service,session:()=>{throw new Error('DB_UNAVAILABLE');}}});
  const open=f.interaction(n,'edit');await ui.interaction(open);assert.deepEqual(open.calls,['MODAL']);
  const save=f.interaction(n,'save',{modal:true,fields:{title:'x',body:'y'}});await ui.interaction(save);
  assert.equal(save.calls[0],'ACK');assert.equal(f.service.get(n.id).content,null);
});
