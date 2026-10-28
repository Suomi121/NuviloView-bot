import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionFlagsBits as P} from 'discord.js';
import {applicationFixture} from './helpers/application-fixture.mjs';
import {recoveryGuild as guildId} from './helpers/recovery-fixture.mjs';
import {createGuildAccess} from '../lib/multi-db/guild-access.mjs';
import {createReactionRoleSettings,handleQuorumReactionRoleCommand} from '../lib/multi-db/reaction-roles.mjs';
const channelId='100000000000000011',messageId='100000000000000012',roleId='100000000000000013',userId='100000000000000014',adminId='100000000000000015';
const rule={channelId,messageId,emojiKey:'unicode:✅',emojiDisplay:'✅',roleIds:[roleId]};
async function setup(t) {
  const f=await applicationFixture(t),gate=createGuildAccess(f);
  await gate.change({guildId,decision:'allow',expected:await gate.read(guildId),actorId:'reviewer',requestId:'allow-reaction-test',
    acknowledgeUnconfirmed:true,occurredAt:1,authorize:async()=>true});
  let admin=true,unsafe=false,fail=false,fenced=false;const calls=[],audits=[];
  const guild={id:guildId};const role={id:roleId,guild};
  const member={id:userId,guild,roles:{cache:new Map(),add:async id=>{calls.push(['add',id]);if(fail)throw Error('ambiguous Discord');member.roles.cache.set(id,role);},
    remove:async id=>{calls.push(['remove',id]);if(fail)throw Error('ambiguous Discord');member.roles.cache.delete(id);}}};
  const bot={id:'100000000000000016',guild,permissions:{has:p=>p===P.ManageRoles}};
  guild.roles={cache:new Map([[roleId,role]]),fetch:async()=>guild.roles.cache};
  guild.members={fetchMe:async()=>bot,fetch:async({user})=>user===adminId?{id:adminId,guild,permissions:{has:p=>p===P.Administrator&&admin}}:member};
  const settings=createReactionRoleSettings({store:f.store,proveOwner:async()=>{if(fenced)throw Error('fenced');},allowGuild:id=>gate.allowed(id),
    safetyError:(r,g)=>!r||r.guild.id!==g.id||unsafe?'unsafe':null,audit:async entry=>{audits.push(entry);}});
  const add=async(extra={})=>settings.change({guild,actorId:adminId,requestId:'set-'+(await settings.load(guildId,adminId)).revision,
    expected:await settings.load(guildId,adminId),rule,...extra});
  const reaction={message:{id:messageId,channelId,guild},emoji:{name:'✅'},partial:false};
  return{...f,gate,guild,member,settings,reaction,calls,audits,add,setAdmin:v=>{admin=v;},setUnsafe:v=>{unsafe=v;},setFailure:v=>{fail=v;},setFence:v=>{fenced=v;}};
}
test('Neon offline: explicit administrator save, fresh add/remove and restart use the same quorum revision',async t=>{
  const f=await setup(t);await f.add();
  const apply=adding=>f.settings.apply({reaction:f.reaction,user:{id:userId,bot:false},adding});
  assert.equal((await apply(true)).state,'CONFIRMED');assert.deepEqual(f.calls,[['add',roleId]]);
  await apply(true);assert.equal(f.calls.length,1); // fresh Discord observed idempotent state
  await apply(false);assert.deepEqual(f.calls,[['add',roleId],['remove',roleId]]);
  assert.equal((await f.store.read({domain:'reaction-roles',guildId,actorId:adminId})).data.rules[0].roleIds[0],roleId);
  assert.deepEqual(f.audits.map(a=>a.state),['DISPATCHED','CONFIRMED','DISPATCHED','CONFIRMED']);
});
test('general member, unknown settings, lost quorum and revoked role permissions are denied',async t=>{
  const f=await setup(t);f.setAdmin(false);await assert.rejects(f.add(),{code:'APP_FORBIDDEN'});f.setAdmin(true);
  await assert.rejects(f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true}),{code:'APP_REACTION_UNCONFIRMED'});
  await f.add();f.setUnsafe(true);await assert.rejects(f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true}),{code:'APP_REACTION_ROLE_UNSAFE'});
  f.setUnsafe(false);f.setFence(true);await assert.rejects(f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true}));f.setFence(false);
  f.faults.supabase=true;await assert.rejects(f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true}));assert.equal(f.calls.length,0);
});
test('stale settings update, cross Guild identity and old blocklist allow cannot authorize effects',async t=>{
  const f=await setup(t),expected=await f.settings.load(guildId,adminId);await f.add();
  await assert.rejects(f.add({expected,requestId:'stale-update'}),{code:'MDB_REVISION_CONFLICT'});
  const foreign={...f.reaction,message:{...f.reaction.message,guild:{id:'100000000000000099'}}};
  await assert.rejects(f.settings.apply({reaction:foreign,user:{id:userId},adding:true}),{code:'APP_GUILD_ACCESS_DENIED'});
  await f.gate.change({guildId,expected:await f.gate.read(guildId),decision:'block',reason:'synthetic review',actorId:'reviewer',requestId:'block',occurredAt:2,authorize:async()=>true});
  await assert.rejects(f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true}),{code:'APP_GUILD_ACCESS_DENIED'});assert.equal(f.calls.length,0);
});
test('ambiguous Discord role response is UNKNOWN, no automatic retry and no success audit',async t=>{
  const f=await setup(t);await f.add();f.setFailure(true);
  const result=await f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true});
  assert.equal(result.state,'UNKNOWN');assert.equal(f.calls.length,1);assert.deepEqual(f.audits.map(a=>a.state),['DISPATCHED','UNKNOWN']);
});
test('remove policy is durable and cannot resurrect via advisory cached roles',async t=>{
  const f=await setup(t);await f.add();await f.add({remove:true,requestId:'remove-rule'});
  assert.equal((await f.settings.apply({reaction:f.reaction,user:{id:userId},adding:true})).state,'IGNORED');assert.equal(f.calls.length,0);
});
test('actual command ACK precedes delayed DB read; no second initial reply; no legacy SQL',async t=>{
  const f=await setup(t),events=[];let resolve;
  const delayed={...f.settings,load:async()=>{events.push('db');await new Promise(r=>{resolve=r;});return f.settings.load(guildId,adminId);}};
  const interaction={id:'isolated-status',guildId,guild:f.guild,user:{id:adminId},options:{getSubcommand:()=> 'list',getChannel:()=>null},
    deferReply:async()=>events.push('ack'),editReply:async value=>events.push(value.content)};
  const promise=handleQuorumReactionRoleCommand(interaction,delayed);while(!resolve)await new Promise(r=>setImmediate(r));
  assert.deepEqual(events,['ack','db']);resolve();await promise;assert.match(events[2],/未確認/);
});
