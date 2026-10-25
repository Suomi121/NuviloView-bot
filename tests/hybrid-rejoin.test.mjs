import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coordinator-fixture.mjs';
import { rejoinVoter,quarantineVoter } from '../lib/multi-db/rejoin.mjs';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
const guild='100000000000000001';
test('old restored disk stays quarantined until full root and namespaced catch-up; other two remain usable',async t=>{
 const f=fixture(t),safe=f.providers.map(p=>quarantineVoter(p,new Set(['neon']))),c=createCoordinator({providers:safe,epoch:'isolated-test-v1'});
 for(const scope of [null,'news-destination','news-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1']){
  const log=scope?c.scoped(scope):c;await log.update({guildId:guild,expectedRevision:0,expectedChecksum:'GENESIS',actorId:'isolated',requestId:'first',action:'test',data:{a:1}});
 }
 assert.equal(f.dbs[0].prepare('SELECT count(*) n FROM mdb_acceptor').get().n,0);
 const result=await rejoinVoter({providers:f.providers,epoch:'isolated-test-v1',targetId:'neon'});assert.equal(result.resources,3);assert.equal(result.quarantineStillRequired,true);
 f.faults.supabase='offline';assert.equal((await f.c.read(guild)).value.data.a,1);
});
test('divergent restored accepted record is quarantined, retained and never auto-merged',async t=>{
 const f=fixture(t);await f.c.update({guildId:guild,expectedRevision:0,expectedChecksum:'GENESIS',actorId:'isolated',requestId:'first',action:'test',data:{a:1}});
 f.dbs[0].prepare("UPDATE mdb_acceptor SET checksum='corrupt' WHERE accepted_ballot IS NOT NULL").run();
 await assert.rejects(rejoinVoter({providers:f.providers,epoch:'isolated-test-v1',targetId:'neon'}),{code:'MDB_REJOIN_CONFLICT'});
 assert.equal(f.dbs[0].prepare('SELECT checksum FROM mdb_acceptor WHERE slot=1').get().checksum,'corrupt');
});
