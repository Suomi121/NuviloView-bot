import { ChannelType,PermissionFlagsBits as P } from 'discord.js';
import { newsFixture,owner,channel,message } from './news-fixture.mjs';
import { createNewsService } from '../../lib/news-service.mjs';
import { createNewsDiscord } from '../../lib/news-discord.mjs';
import { createNewsDestinationSelector } from '../../lib/news-destinations.mjs';
import { normalizeDiscordMessageEvent } from '../../lib/message-local-first.mjs';
export const at=Date.UTC(2026,9,26),g='400000000000000001',c1='500000000000000001',c2='500000000000000002',botId='700000000000000001';
export function autoFixture(t,{ids=[g],definitions=null,activity=null,destinationControl=null,cloud=null,databasePath=':memory:',storageAt=at}={}){
 const f=newsFixture(t,{databasePath,storageNow:()=>storageAt});f.clock(at-f.options.now());
 const guildMap=new Map(),sends=[],edits=[],faults={},historyReads=[];let serial=0;
 for(const guildId of ids){
  const channels=new Map(),guild={id:guildId,roles:{fetch:async()=>new Map()},members:{fetchMe:async()=>({id:botId,guild})}};
  Object.defineProperty(guild,'systemChannelId',{get(){throw Error('NO_SYSTEM_PRIORITY');}});
  guild.channels={fetch:async id=>{if(faults[guildId]==='channels')throw Error('SECRET');return id?channels.get(id)??null:new Map([...channels].filter(([,c])=>!c.isThread()));},
   fetchActiveThreads:async()=>{if(faults[guildId]==='threads')throw Error('SECRET');return{threads:new Map([...channels].filter(([,c])=>c.isThread()))};}};
  guildMap.set(guildId,guild);
  for(const definition of definitions??[{id:c1},{id:c2}]){
   const id=ids.length===1?definition.id:String(BigInt(definition.id)+(BigInt(guildId)-BigInt(g))*100n);
   const thread=[ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread].includes(definition.type);
   const permissions=new Set([P.ViewChannel,P.EmbedLinks,thread?P.SendMessagesInThreads:P.SendMessages]);if(definition.sendable===false)permissions.delete(thread?P.SendMessagesInThreads:P.SendMessages);
   const ch={id,guildId,type:definition.type??ChannelType.GuildText,archived:definition.archived??false,
    isThread:()=>thread,isDMBased:()=>false,isSendable:()=>true,permissionsFor:()=>({has:flags=>(Array.isArray(flags)?flags:[flags]).every(p=>permissions.has(p))}),permissions,
    messages:{fetch:async()=>{historyReads.push(id);return{some:()=>false};}},
    send:async payload=>{if(faults[guildId]?.status)throw faults[guildId];sends.push({guildId,channelId:id,payload});return{id:String(800000000000000000n+BigInt(sends.length)),guildId,channelId:id};}};
   for(const key of ['name','topic','position'])Object.defineProperty(ch,key,{get(){throw Error('NO_NAME_OR_PURPOSE_PRIORITY');}});
   channels.set(id,ch);
  }
 }
 const dm={id:channel,messages:{edit:async(id,payload)=>edits.push(payload)}};
 const client={user:{id:botId},guilds:{fetch:async options=>typeof options==='string'?guildMap.get(options):new Map([...guildMap].filter(([id])=>!options.after||BigInt(id)>BigInt(options.after)).slice(0,options.limit??200))},
  users:{fetch:async()=>({createDM:async()=>dm})}};
 const selector=createNewsDestinationSelector({client,now:()=>at,activity:activity??((id,options)=>f.db.messageDomain.getChannelMessageActivity(id,options))});
 const service=createNewsService({...f.options,cloud:cloud??f.cloud,destinationControl,selectDestination:selector});
 const ui=createNewsDiscord({service,client,isDeveloper:id=>f.allowed.has(id),allow:()=>true});
 const input=n=>({id:n.id,ownerId:owner,nonce:n.nonce,version:n.version,channelId:channel,messageId:message});
 async function draft(){let n=await service.create(owner);n=service.bind(n.id,owner,channel,message);return service.edit(input(n),{title:'合成ニュース',body:'Synthetic only'});}
 async function planned(){return service.prepare(input(await draft()),[...guildMap.keys()]);}
 async function queued(){const n=await planned();return service.confirm(input(n));}
 function addMessages(channelId,count,{guildId=g,age=1000,bot=false,webhook=false,unknown=false}={}){
  for(let i=0;i<count;i++){
   const event=normalizeDiscordMessageEvent({id:String(900000000000000000n+BigInt(++serial)),guild:{id:guildId},channelId,
    author:{id:'600000000000000001',bot},webhookId:webhook?'600000000000000002':null,content:'synthetic-not-returned',createdTimestamp:at-age},'create',{now:()=>at});
   if(unknown)delete event.payload.isWebhook;
   f.db.messageDomain.recordEvent(event);
  }
 }
 return{...f,service,selector,ui,client,guildMap,sends,edits,faults,historyReads,input,draft,planned,queued,addMessages};
}
