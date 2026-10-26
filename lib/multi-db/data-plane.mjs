import { randomUUID, createHmac } from 'node:crypto';
import { encodeErasure, decodeErasure, sealArtifact, openArtifact, digestBytes } from './erasure.mjs';
import { denied } from './coordinator.mjs';

export const SHARD_SCHEMA=`CREATE TABLE IF NOT EXISTS mdb_blob_shard (
 artifact_id TEXT NOT NULL, version TEXT NOT NULL, shard_index INTEGER NOT NULL CHECK(shard_index BETWEEN 0 AND 2),
 payload TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(artifact_id,version,shard_index));`;
export function createShardStore({ id, dialect, execute,tablePrefix='' }) {
  const idx=['neon','supabase','turso'].indexOf(id);if(idx<0)denied('EC_PROVIDER');
  const p=i=>dialect==='postgres'?`$${i}`:`?${i}`;
  if(tablePrefix&&!/^nvq_[a-f0-9]{16}_$/.test(tablePrefix))denied('EC_TABLE_PREFIX');
  const query=async(q,args)=>{const r=await execute(q.replace(/\bmdb_blob_shard\b/g,`${tablePrefix}mdb_blob_shard`),args);return Array.isArray(r)?r:r?.rows??[];};
  return Object.freeze({id,
    async put(artifact,version,index,bytes){
      if(index!==idx)denied('EC_PROVIDER_INDEX');
      const hash=digestBytes(bytes),data=bytes.toString('base64');
      const rows=await query(`INSERT INTO mdb_blob_shard(artifact_id,version,shard_index,payload,checksum)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)}) ON CONFLICT(artifact_id,version,shard_index)
       DO UPDATE SET payload=excluded.payload WHERE mdb_blob_shard.checksum=excluded.checksum RETURNING checksum`,[artifact,version,index,data,hash]);
      if(rows[0]?.checksum!==hash)denied('EC_SHARD_CONFLICT');
    },
    async get(artifact,version,index){const r=(await query(`SELECT payload,checksum FROM mdb_blob_shard WHERE artifact_id=${p(1)} AND version=${p(2)} AND shard_index=${p(3)}`,[artifact,version,index]))[0];
      if(!r)return null;const bytes=Buffer.from(r.payload,'base64');if(digestBytes(bytes)!==r.checksum)denied('EC_SHARD_CORRUPT');return bytes;},
  });
}
export function createDataPlane({ coordinator, stores, timeoutMs=3000, maxBytes=32*1024*1024 }) {
  if(stores.length!==3||stores.map(p=>p.id).sort().join(',')!=='neon,supabase,turso')denied('EC_CONFIGURATION');
  const byId=new Map(stores.map(p=>[p.id,p]));
  const ordered=['neon','supabase','turso'].map(id=>byId.get(id));
  const scope=id=>{if(!/^[a-f0-9]{32}$/.test(id))denied('EC_ARTIFACT_ID');return coordinator.scoped(`blob-${id}`);};
  const bounded=async fn=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('EC_TIMEOUT')),timeoutMs);})]);}finally{clearTimeout(timer);}};
  async function fragments(m){return (await Promise.all(ordered.map(async(p,index)=>{try{const bytes=await bounded(()=>p.get(m.artifactId,m.version,index));return bytes?{index,bytes}:null;}catch{return null;}}))).filter(Boolean);}
  return Object.freeze({
    async save({guildId,artifactId,bytes,actorId,requestId,expectedRevision=0,expectedChecksum='GENESIS',sensitive=false,key=null,keyId=null}){
      const input=Buffer.from(bytes);if(input.length>maxBytes)denied('EC_CAPACITY');
      const sealed=sealArtifact(input,{sensitive,key,keyId}),e=encodeErasure(sealed.bytes),version=randomUUID().replaceAll('-','');
      const inputDigest=sensitive?createHmac('sha256',key).update(input).digest('hex'):digestBytes(input);
      const manifest={codec:'xor-mds-3-2-v1',artifactId,version,length:e.length,checksum:e.checksum,hashes:e.hashes,encryption:sealed.encryption,inputDigest};
      const c=scope(artifactId);
      let old=null;try{old=await c.read(guildId);}catch(e){if(e.code!=='MDB_NOT_ENROLLED')throw e;}
      if(old?.value.requestId===requestId){
        if(old.value.actorId!==actorId||old.value.data.inputDigest!==inputDigest||old.value.data.encryption?.keyId!==(sealed.encryption?.keyId)||old.value.revision!==expectedRevision+1||old.value.previousChecksum!==expectedChecksum)denied('MDB_IDEMPOTENCY_CONFLICT');
        return old;
      }
      if((old?.value.revision??0)!==expectedRevision||(old?.checksum??'GENESIS')!==expectedChecksum)denied('MDB_REVISION_CONFLICT');
      const saved=await Promise.all(ordered.map(async(p,i)=>{try{await bounded(()=>p.put(artifactId,version,i,e.shards[i]));return true;}catch{return false;}}));
      if(saved.filter(Boolean).length<2)denied('EC_INSUFFICIENT_SHARDS');
      // Fragments are immutable/unreachable until the manifest is chosen.
      return c.update({guildId,actorId,requestId,expectedRevision,expectedChecksum,action:'blob:manifest',data:manifest});
    },
    async read({guildId,artifactId,key=null}){const chosen=await scope(artifactId).read(guildId),m=chosen.value.data;
      if(m.artifactId!==artifactId)denied('EC_MANIFEST');
      const bytes=decodeErasure(m,await fragments(m));return {bytes:openArtifact(bytes,m.encryption,key),chosen};},
    async repair({guildId,artifactId}){const chosen=await scope(artifactId).read(guildId),m=chosen.value.data;
      const bytes=decodeErasure(m,await fragments(m)),e=encodeErasure(bytes);
      const results=await Promise.all(ordered.map(async(p,i)=>{try{await bounded(()=>p.put(artifactId,m.version,i,e.shards[i]));return p.id;}catch{return null;}}));
      return {revision:chosen.value.revision,available:results.filter(Boolean),complete:results.every(Boolean)};},
  });
}
