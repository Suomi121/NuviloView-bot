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
export function createApplicationRepairer({ coordinator, dataPlane, controlId, key=null,keyId=null,now=Date.now, intervalMs=30000,checkpointInterval=128 }) {
  if(!Number.isInteger(checkpointInterval)||checkpointInterval<1||checkpointInterval>1000)denied('APP_REPAIR_CONFIGURATION');
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
        if(result.revision>=checkpointInterval){if(!Buffer.isBuffer(key)||key.length!==32||!keyId)denied('APP_CHECKPOINT_KEY_REQUIRED');
          // Archive full history without deleting old promises/accepted values.
          const checkpoint=await dataPlane.checkpoint({guildId,artifactId,key,keyId,minRevisions:checkpointInterval,actorId:'application-repair',requestId:`checkpoint:${artifactId}:${result.revision}`});
          // Checkpoint archives also need discovery/repair when a previously
          // missing provider returns; retaining only two original shards is
          // not enough for later independent provider failure.
          if(checkpoint?.value.data.artifactId)await registerApplicationArtifact({coordinator,guildId,artifactId:checkpoint.value.data.artifactId,actorId:'application-repair'});}
      }catch(e){if(e.code!=='MDB_NOT_ENROLLED')throw e;state='UNCOMMITTED_ARTIFACT';}}
      lastSuccess=now();lastError=null;if(item>=ids.length){item=0;cursor++;}
    } catch(e){state='DEGRADED';lastError=/^(APP|MDB|EC)_[A-Z_]+$/.test(e.code??'')?e.code:'APP_REPAIR_UNAVAILABLE';}
  }, status:()=>({state,lastAttempt,lastSuccess,lastError,cursor,item,epoch:coordinator.epoch,destructiveCleanup:false}) };
}
