import assert from 'node:assert/strict';
import { Client } from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { createPostgresProviderAdapter } from '../../lib/sync/providers/postgres.mjs';
import { createTursoProviderAdapter } from '../../lib/sync/providers/turso.mjs';
import { createNewsCloudGuard } from '../../lib/news-cloud-guard.mjs';
import { normalizeSyncEnvelope } from '../../lib/sync/conflict-policy.mjs';

export async function verifyNewsCloud(connectionString) {
  const url=new URL(connectionString);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/nuviloview_spam_test');
  const a=new Client({connectionString}),b=new Client({connectionString});await a.connect();await b.connect();
  const db=new DatabaseSync(':memory:');
  try{
    for(const [client,name] of [[a,'news_claim_a'],[b,'news_claim_b']]){
      await client.query(`CREATE SCHEMA ${name}; SET search_path=${name}`);
      await client.query(`CREATE TABLE replica_event(event_id text PRIMARY KEY,domain text,event_type text,
        aggregate_id text,payload jsonb,schema_version integer,checksum text,source_created_at bigint,received_at timestamptz DEFAULT now())`);
    }
    db.exec(`CREATE TABLE replica_event(event_id TEXT PRIMARY KEY,domain TEXT,event_type TEXT,aggregate_id TEXT,
      payload TEXT,schema_version INTEGER,checksum TEXT,source_created_at INTEGER,received_at INTEGER)`);
    const execute=({sql,args=[]})=>({rows:db.prepare(sql).all(...args)});
    const tursoClient={execute:async stmt=>execute(stmt),batch:async stmts=>{
      db.exec('BEGIN IMMEDIATE');try{const results=stmts.map(execute);db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}
    }};
    const providers=[createPostgresProviderAdapter({id:'neon',enabled:true,execute:(q,p)=>a.query(q,p)}),
      createPostgresProviderAdapter({id:'supabase',enabled:true,execute:(q,p)=>b.query(q,p)}),createTursoProviderAdapter({enabled:true,client:tursoClient})];
    const cloud=createNewsCloudGuard({registry:{list:()=>providers}});
    const e=nonce=>normalizeSyncEnvelope({eventId:'isolated-news-claim',domain:'security',eventType:'news_delivery_claim_v1',aggregateId:'news-test',payload:{nonce},createdAt:1});
    const results=await Promise.allSettled([cloud.claim(e('writer-a')),cloud.claim(e('writer-b'))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'real SQL only grants one majority claim');
    const winner=results[0].status==='fulfilled'?e('writer-a'):e('writer-b');
    assert.equal(await cloud.verify(winner.eventId,winner.checksum),true);
    await assert.rejects(cloud.claim(winner),{code:'NEWS_EXISTING_CLAIM'});
    await a.query('SET default_transaction_read_only=on');
    const outage=normalizeSyncEnvelope({...e('new'),eventId:'isolated-news-neon-readonly',checksum:undefined});
    assert.equal(await cloud.claim(outage),outage.checksum,'Supabase and Turso adapters preserve claim safety with Neon read-only');
    await a.query('SET default_transaction_read_only=off');
    const outcome=normalizeSyncEnvelope({...outage,eventId:'isolated-news-result',eventType:'news_delivery_result_v1',checksum:undefined,payload:{status:'failed',code:'FORBIDDEN'}});
    await cloud.record(outcome);assert.equal(await cloud.verify(outcome.eventId,outcome.checksum),true);
    await cloud.record(outcome);
    assert.equal((await a.query('SELECT count(*)::int n FROM replica_event WHERE event_id=$1',[outcome.eventId])).rows[0].n,1);
  }finally{db.close();await a.end();await b.end();}
}
