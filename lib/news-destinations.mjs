import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { newsError, newsIdValid } from './news-contract.mjs';

const day=86400_000;
export const newsIdOrder=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const knownSendable=new Set([ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread]);
const threadTypes=new Set([ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread]);

// Type is only used for API capability/permission checks, NEVER ranking.
// No channel name, position, topic, system-channel or announcement preference.
export function newsChannelUsable(channel,bot,guildId) {
  if(!channel||channel.guildId!==guildId||!newsIdValid(channel.id)||channel.isDMBased?.()===true||typeof channel.send!=='function')return false;
  if(channel.isSendable ? channel.isSendable()!==true : !knownSendable.has(channel.type))return false;
  const thread=channel.isThread?.()===true||threadTypes.has(channel.type);
  // Never reopen archived threads as a side effect of a news broadcast.
  if(thread&&(channel.archived!==false||channel.sendable===false))return false;
  try{return channel.permissionsFor(bot)?.has([P.ViewChannel,P.EmbedLinks,thread?P.SendMessagesInThreads:P.SendMessages])===true;}
  catch{return false;}
}
export async function freshNewsBot(guild,client) {
  if(typeof guild.roles?.fetch!=='function')newsError('NEWS_PERMISSION_UNAVAILABLE');
  await guild.roles.fetch();
  const bot=await guild.members.fetchMe({force:true});
  if(bot?.id!==client.user?.id||bot?.guild?.id!==guild.id)newsError('NEWS_PERMISSION_UNAVAILABLE');
  return bot;
}

export function auditNewsActivity(raw,guildId,at) {
  const empty=reason=>({counts:new Map(),status:reason,windowStart:at-7*day,windowEnd:at,coverage:'OBSERVED_LOCAL_ONLY'});
  if(!raw||raw.guildId!==guildId||raw.windowStart!==at-7*day||raw.windowEnd!==at||
    raw.generatedAt!==at||!Array.isArray(raw.channels)||raw.channels.length>10000)return empty('UNVERIFIED');
  const counts=new Map();let latest=null;
  for(const row of raw.channels){
    if(!newsIdValid(row.channelId)||counts.has(row.channelId)||!Number.isSafeInteger(row.messages)||row.messages<0||
      !Number.isSafeInteger(row.firstMessageAt)||!Number.isSafeInteger(row.lastMessageAt)||
      row.firstMessageAt<raw.windowStart||row.lastMessageAt>at||row.firstMessageAt>row.lastMessageAt||
      !Number.isSafeInteger(row.lastRecordedAt)||row.lastRecordedAt<row.lastMessageAt||row.lastRecordedAt>at)return empty('UNVERIFIED');
    counts.set(row.channelId,row.messages);latest=Math.max(latest??0,row.lastRecordedAt);
  }
  if(latest===null)return empty('NO_DATA');
  // Old collection is not presented as fresh coverage. Unknown/stale statistics
  // do not block delivery: they only disable ranking, then use capability fallback.
  if(at-latest>day)return empty('STALE');
  return{counts,status:'FRESH_OBSERVED',windowStart:raw.windowStart,windowEnd:at,coverage:'OBSERVED_LOCAL_ONLY'};
}

export function createNewsDestinationSelector({client,activity=()=>null,now=Date.now}) {
  return async(guildId,configured={})=>{
    if(!newsIdValid(guildId))newsError('NEWS_GUILD');
    const at=now(),unavailable=reason=>({guildId,channelId:null,selection:{version:1,mode:'unavailable',reason,selectedAt:at}});
    let guild,bot;
    try{guild=await client.guilds.fetch(guildId);if(guild?.id!==guildId)return unavailable('GUILD_UNAVAILABLE');bot=await freshNewsBot(guild,client);}
    catch{return unavailable('GUILD_OR_PERMISSIONS_UNAVAILABLE');}
    let explicitUnavailable=null;
    if(configured.channelId){
      try{const ch=await guild.channels.fetch(configured.channelId,{force:true});
        if(newsChannelUsable(ch,bot,guildId))return{guildId,channelId:ch.id,selection:{version:1,mode:'explicit',selectedAt:at}};
      }catch{/* Read error is not permission to send to an unverified channel. */}
      explicitUnavailable='EXPLICIT_DESTINATION_UNAVAILABLE';
    }
    const candidates=new Map();let channels;
    try{channels=await guild.channels.fetch();if(!channels||typeof channels.values!=='function')return unavailable('CHANNEL_DISCOVERY_FAILED');}
    catch{return unavailable('CHANNEL_DISCOVERY_FAILED');}
    for(const ch of channels.values())if(newsChannelUsable(ch,bot,guildId))candidates.set(ch.id,ch);
    // Metadata only, no archived-thread enumeration, joining or message crawl.
    let threadDiscovery='COMPLETE';
    try{const result=await guild.channels.fetchActiveThreads(false);for(const ch of result.threads.values())if(newsChannelUsable(ch,bot,guildId))candidates.set(ch.id,ch);}
    catch{threadDiscovery='UNAVAILABLE';}
    if(candidates.size>10000)return unavailable('CHANNEL_CAPACITY');
    if(!candidates.size)return unavailable(threadDiscovery==='COMPLETE'?'NO_SENDABLE_CHANNEL':'CHANNEL_DISCOVERY_INCOMPLETE');
    if(configured.channelId&&candidates.has(configured.channelId))return{guildId,channelId:configured.channelId,selection:{version:1,mode:'explicit',selectedAt:at}};
    let raw;try{raw=await activity(guildId,{at});}catch{/* fallback, not raw DB diagnostics */}
    const stats=auditNewsActivity(raw,guildId,at),ids=[...candidates.keys()].sort(newsIdOrder);
    const ranked=[...ids].sort((a,b)=>(stats.counts.get(b)??0)-(stats.counts.get(a)??0)||newsIdOrder(a,b));
    const count=stats.counts.get(ranked[0])??0,channelId=count>0?ranked[0]:ids[0];
    return{guildId,channelId,selection:{version:1,mode:count>0?'activity':'fallback',selectedAt:at,
      ...(explicitUnavailable?{explicitUnavailable}:{}),threadDiscovery,
      activity:{status:stats.status,windowStart:stats.windowStart,windowEnd:stats.windowEnd,coverage:stats.coverage,messages:count>0?count:0}}};
  };
}
