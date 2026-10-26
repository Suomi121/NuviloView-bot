import { denied } from './coordinator.mjs';
// Publish discovery BEFORE the blob manifest. A crash can leave a harmless
// uncommitted catalog item, never an undiscoverable committed application blob.
export async function registerApplicationArtifact({ coordinator, guildId, artifactId, actorId }) {
  const c = coordinator.scoped('application-repair');
  let old;try { old = await c.read(guildId); } catch(e) { if(e.code !== 'MDB_NOT_ENROLLED') throw e; }
  const ids = old?.value.data.artifactIds ?? [];
  if (!Array.isArray(ids) || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) denied('APP_REPAIR_CATALOG');
  if (ids.includes(artifactId)) return;
  if (ids.length >= 10000) denied('APP_CAPACITY');
  await c.update({ guildId,actorId,requestId:`catalog:${artifactId}`,expectedRevision:old?.value.revision ?? 0,expectedChecksum:old?.checksum ?? 'GENESIS',
    action:'application:register-artifact',data:{artifactIds:[...ids,artifactId].sort()} });
}
export function createApplicationRepairer({ coordinator, dataPlane, controlId, key=null,keyId=null,now=Date.now, intervalMs=30000 }) {
  let cursor=0,item=0,lastAttempt=null,lastSuccess=null,state='NOT_RUN',lastError=null;
  return { async processOnce() {
    if(lastAttempt!==null && now()-lastAttempt<intervalMs)return;
    lastAttempt=now();
    try {
      const guilds=[...new Set([...(await coordinator.listGuilds()),controlId].filter(Boolean))];
      const guildId=guilds[cursor%guilds.length];if(!guildId)return;
      let catalog;try{catalog=await coordinator.scoped('application-repair').read(guildId);}catch(e){if(e.code!=='MDB_NOT_ENROLLED')throw e;cursor++;return;}
      const ids=catalog.value.data.artifactIds;
      if(!Array.isArray(ids)||ids.some(id=>!/^[a-f0-9]{32}$/.test(id)))denied('APP_REPAIR_CATALOG');
      const artifactId=ids[item++%Math.max(1,ids.length)];
      if(artifactId){try{const result=await dataPlane.repair({guildId,artifactId});state=result.complete?'CONSISTENT':'REPAIR_PENDING';
        if(result.revision>=128){if(!Buffer.isBuffer(key)||key.length!==32||!keyId)denied('APP_CHECKPOINT_KEY_REQUIRED');
          // Archive full history without deleting old promises/accepted values.
          await dataPlane.checkpoint({guildId,artifactId,key,keyId,minRevisions:128,actorId:'application-repair',requestId:`checkpoint:${artifactId}:${result.revision}`});}
      }catch(e){if(e.code!=='MDB_NOT_ENROLLED')throw e;state='UNCOMMITTED_ARTIFACT';}}
      lastSuccess=now();lastError=null;if(item>=ids.length){item=0;cursor++;}
    } catch(e){state='DEGRADED';lastError=/^(APP|MDB|EC)_[A-Z_]+$/.test(e.code??'')?e.code:'APP_REPAIR_UNAVAILABLE';}
  }, status:()=>({state,lastAttempt,lastSuccess,lastError,cursor,item,epoch:coordinator.epoch,destructiveCleanup:false}) };
}
