import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { createSqlAcceptor } from '../lib/multi-db/acceptor.mjs';
test('actual PostgreSQL server restart retains chosen history with third voter absent',{skip:process.env.TEST_HYBRID_RESTART!=='1'},async t=>{
 const url=new URL(process.env.TEST_COORDINATOR_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/nuviloview_quorum_test');
 const a=new Client({connectionString:url.href}),b=new Client({connectionString:url.href});await a.connect();await b.connect();t.after(async()=>{await a.end();await b.end();});
 await a.query('SET search_path=neon');await b.query('SET search_path=supabase');
 const providers=[createSqlAcceptor({id:'neon',dialect:'postgres',execute:(q,p)=>a.query(q,p)}),createSqlAcceptor({id:'supabase',dialect:'postgres',execute:(q,p)=>b.query(q,p)}),createSqlAcceptor({id:'turso',dialect:'sqlite',execute:async()=>{throw Error('absent');}})];
 const c=createCoordinator({providers,epoch:'isolated-v1'}),state=await c.read('100000000000000001');
 assert.equal(state.value.revision,3);assert.equal(state.value.data.autoTimeout,true);assert.equal(state.value.data.policy.strength,79);
});
