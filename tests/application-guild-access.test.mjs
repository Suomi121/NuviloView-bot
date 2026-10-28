import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {applicationFixture} from './helpers/application-fixture.mjs';
import {recoveryGuild as guildId} from './helpers/recovery-fixture.mjs';
import {createGuildAccess} from '../lib/multi-db/guild-access.mjs';
import {createNewsDiscord} from '../lib/news-discord.mjs';
import {createSecurityService} from '../lib/multi-db/security-service.mjs';
const require = createRequire(import.meta.url);
test('Neon offline: unknown is denied, reviewed allow and block are fresh quorum decisions with audit', async t => {
  const f=await applicationFixture(t), service=createGuildAccess(f);
  const unknown=await service.read(guildId);assert.equal(unknown.decision,'unknown');assert.equal(await service.allowed(guildId),false);
  const args={guildId,decision:'allow',actorId:'isolated-developer',requestId:'reviewed-allow',expected:unknown,occurredAt:1,authorize:async()=>true};
  await assert.rejects(service.change(args),{code:'APP_CONFIRMATION_REQUIRED'});
  await assert.rejects(service.change({...args,authorize:async()=>false}),{code:'APP_FORBIDDEN'});
  await service.change({...args,acknowledgeUnconfirmed:true});assert.equal(await service.allowed(guildId),true);
  const allowed=await service.read(guildId);assert.equal(allowed.data.audit.length,1);
  await service.change({...args,decision:'block',reason:'synthetic policy review',expected:allowed,requestId:'block'});
  assert.equal(await service.allowed(guildId),false);assert.equal((await service.read(guildId)).data.audit.length,2);
  await assert.rejects(service.change({...args,acknowledgeUnconfirmed:true,requestId:'stale'}),{code:'MDB_REVISION_CONFLICT'});
  assert.equal(await service.allowed('100000000000000099'),false);
});
test('lost quorum never uses old allow cache; restart recovers exact chosen policy', async t => {
  const f=await applicationFixture(t), service=createGuildAccess(f), expected=await service.read(guildId);
  await service.change({guildId,expected,decision:'allow',actorId:'reviewer',requestId:'allow',acknowledgeUnconfirmed:true,occurredAt:1,authorize:async()=>true});
  f.faults.supabase=true;assert.equal(await service.allowed(guildId),false);f.faults.supabase=false;
  assert.equal(await createGuildAccess(f).allowed(guildId),true);
  assert.equal((await service.list())[0].decision,'allow');
});
test('fresh blocklist gate denies news before Discord and automatic punishment; disabling stays available',async t=>{
  const f=await applicationFixture(t),gate=createGuildAccess(f),security=createSecurityService(f.coordinator,{allowGuild:id=>gate.allowed(id)});
  const discord=createNewsDiscord({service:{},client:{},isDeveloper:()=>true,allowGuild:id=>gate.allowed(id)});
  await assert.rejects(discord.transport.send({guildId},{}),{code:'NEWS_PERMISSION'});
  assert.equal(await security.automaticAllowed(guildId,{emergencyStop:false}),false);
  const old=await security.read(guildId),args={guildId,actorId:'admin',requestId:'auto-off',expectedRevision:old.value.revision,expectedChecksum:old.checksum,
    operation:'auto:off',authorize:async()=>true};
  await security.change(args);assert.equal((await security.read(guildId)).value.data.autoTimeout,false);
  const latest=await security.read(guildId);
  await assert.rejects(security.change({...args,requestId:'unsafe-on',operation:'auto:on',expectedRevision:latest.value.revision,expectedChecksum:latest.checksum}),{code:'APP_GUILD_ACCESS_DENIED'});
});
function loadRoute(service,{developer=true,trusted=true}={}) {
  const source=fs.readFileSync(new URL('../app/api/developer/guilds/route.ts',import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,mod={exports:{}};
  const mocks={'@/lib/developer-access':{getDeveloperAccess:async()=>developer?{userId:'reviewer',discordUserId:'100000000000000003'}:null},
    '@/lib/db':{pool:{query:async()=>{throw Error('LEGACY_SQL_WAS_CALLED');}}},
    '@/lib/multi-db/guild-access-web':{getApplicationGuildAccess:async()=>service,getDeveloperGuildRegistry:async()=>new Map()},
    '@/lib/multi-db/application-web':{applicationError:e=>({status:/CONFLICT|CONFIRMATION/.test(e.code)?409:503,body:{code:e.code}})},
    '@/lib/request-security':{isTrustedMutation:()=>trusted,hasJsonBody:()=>true,isRateLimited:async()=>false},
    '@/lib/audit-log':{},'@/lib/guild-reset-utils.mjs':{getGuildResetConfig:()=>({enabled:false})}};
  new Function('require','module','exports',js)(id=>mocks[id]??require(id),mod,mod.exports);return mod.exports;
}
test('actual developer API: session/CSRF preserved, unknown explicit CAS, no Neon or implicit data purge',async t=>{
  const old=process.env.APPLICATION_DATA_MODE;process.env.APPLICATION_DATA_MODE='quorum';t.after(()=>{if(old===undefined)delete process.env.APPLICATION_DATA_MODE;else process.env.APPLICATION_DATA_MODE=old;});
  const f=await applicationFixture(t),service=createGuildAccess(f),api=loadRoute(service);
  const request=body=>new Request('https://isolated.invalid/api/developer/guilds',{method:'POST',body:JSON.stringify(body)});
  const b=await(await api.GET(new Request('https://isolated.invalid/api/developer/guilds'))).json();assert.equal(b.guilds[0].decision,'unknown');
  const body={action:'unblock',guildId,token:b.guilds[0].token,requestId:'api-reviewed',acknowledgeUnconfirmed:true};
  assert.equal((await loadRoute(service,{developer:false}).POST(request(body))).status,403);
  assert.equal((await loadRoute(service,{trusted:false}).POST(request(body))).status,400);
  assert.equal((await api.POST(request(body))).status,200);assert.equal(await service.allowed(guildId),true);
  assert.equal((await api.POST(request({...body,requestId:'stale'}))).status,409);
  assert.equal((await f.security.read(guildId)).value.data.autoTimeout,false);
});
