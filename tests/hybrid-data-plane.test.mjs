import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers/coordinator-fixture.mjs';
import { createDataPlane, createShardStore, SHARD_SCHEMA } from '../lib/multi-db/data-plane.mjs';
import { encodeErasure, decodeErasure } from '../lib/multi-db/erasure.mjs';
const guildId='100000000000000001',artifactId='a'.repeat(32);
function setup(t){const f=fixture(t);f.dbs.forEach(db=>db.exec(SHARD_SCHEMA));
 const stores=['neon','supabase','turso'].map((id,i)=>createShardStore({id,dialect:'sqlite',execute:async(q,p)=>{if(f.faults[id])throw Error('OFFLINE');return f.dbs[i].prepare(q).all(...p);}}));
 return {...f,stores,data:createDataPlane({coordinator:f.c,stores})};}
for(const absent of [0,1,2])test(`MDS arbitrary pair without fragment ${absent}: empty/odd/binary data`,()=>{
 for(const bytes of [Buffer.alloc(0),Buffer.from('odd'),randomBytes(2049)]){const e=encodeErasure(bytes),m={...e,shards:undefined,codec:'xor-mds-3-2-v1'};
 assert.deepEqual(decodeErasure(m,e.shards.map((bytes,index)=>({index,bytes})).filter(s=>s.index!==absent)),bytes);}
});
test('corrupt, mixed version and duplicate fragments never reconstruct unverified data',()=>{
 const e=encodeErasure(Buffer.from('synthetic archive')),m={...e,codec:'xor-mds-3-2-v1'};
 assert.throws(()=>decodeErasure(m,[{index:0,bytes:e.shards[0]},{index:1,bytes:Buffer.alloc(e.shards[1].length)}]),{code:'EC_INSUFFICIENT_SHARDS'});
 assert.throws(()=>decodeErasure({...m,checksum:'bad'},[{index:0,bytes:e.shards[0]},{index:1,bytes:e.shards[1]}]),{code:'EC_CHECKSUM'});
 assert.throws(()=>decodeErasure(m,[{index:0,bytes:e.shards[0]},{index:0,bytes:e.shards[0]}]),{code:'EC_MANIFEST'});
});
for(const offline of ['neon','supabase','turso'])test(`new artifact with ${offline} absent, catch-up and immutable fragments`,async t=>{
 const f=setup(t);f.faults[offline]='offline';const bytes=randomBytes(1025);
 const saved=await f.data.save({guildId,artifactId,bytes,actorId:'isolated',requestId:'save'});
 assert.equal((await f.data.save({guildId,artifactId,bytes,actorId:'isolated',requestId:'save'})).checksum,saved.checksum,'same request recovers original manifest');
 assert.equal(saved.value.revision,1);assert.deepEqual((await f.data.read({guildId,artifactId})).bytes,bytes);
 f.faults[offline]=null;assert.equal((await f.data.repair({guildId,artifactId})).complete,true);
 f.dbs[0].prepare("UPDATE mdb_blob_shard SET payload='corrupt'").run();
 assert.equal((await f.data.repair({guildId,artifactId})).complete,true);
 assert.deepEqual((await f.data.read({guildId,artifactId})).bytes,bytes);
 const version=saved.value.data.version;
 await assert.rejects(f.stores[0].put(artifactId,version,0,Buffer.from('different')),{code:'EC_SHARD_CONFLICT'});
 f.faults.supabase='offline';f.faults.turso='offline';await assert.rejects(f.data.read({guildId,artifactId}));
});
test('sensitive archives require encryption key; authenticated decrypt and version CAS',async t=>{
 const f=setup(t),bytes=Buffer.from('synthetic sensitive fixture'),key=randomBytes(32);
 await assert.rejects(f.data.save({guildId,artifactId,bytes,actorId:'isolated',requestId:'bad',sensitive:true}),{code:'EC_ENCRYPTION_REQUIRED'});
 const first=await f.data.save({guildId,artifactId,bytes,actorId:'isolated',requestId:'first',sensitive:true,key,keyId:'test-key'});
 assert.deepEqual((await f.data.read({guildId,artifactId,key})).bytes,bytes);
 await assert.rejects(f.data.read({guildId,artifactId,key:randomBytes(32)}),{code:'EC_DECRYPTION'});
 assert.ok(f.dbs.every(db=>!db.prepare('SELECT payload FROM mdb_blob_shard').get().payload.includes(bytes.toString('base64'))));
 await assert.rejects(f.data.save({guildId,artifactId,bytes,actorId:'isolated',requestId:'stale'}),{code:'MDB_REVISION_CONFLICT'});
 const next=await f.data.save({guildId,artifactId,bytes:Buffer.from('next'),actorId:'isolated',requestId:'next',expectedRevision:1,expectedChecksum:first.checksum});
 assert.equal(next.value.revision,2);assert.equal((await f.data.read({guildId,artifactId})).bytes.toString(),'next');
});
test('1MiB archive overhead is 1.5x before base64; timed roundtrip without Production',async t=>{
 const f=setup(t),bytes=randomBytes(1024*1024),start=performance.now();
 await f.data.save({guildId,artifactId,bytes,actorId:'isolated',requestId:'large'});
 assert.deepEqual((await f.data.read({guildId,artifactId})).bytes,bytes);
 const stored=f.dbs.reduce((n,db)=>n+db.prepare('SELECT length(payload) AS n FROM mdb_blob_shard').get().n,0);
 t.diagnostic(JSON.stringify({inputBytes:bytes.length,encodedBase64Bytes:stored,elapsedMs:Math.round(performance.now()-start)}));
 assert.equal(stored,2097156);
});
