import {canonical,checksum,createCoordinator,denied} from './coordinator.mjs';
import {ACCEPTOR_SCHEMA} from './acceptor.mjs';
import {createSecurityService} from './security-service.mjs';
import {quarantineVoter} from './rejoin.mjs';
import {SHARD_SCHEMA} from './data-plane.mjs';

export const recoveryPrefix=epoch=>`nvq_${checksum(epoch).slice(0,16)}_`;
export function recoverySchema(epoch){if(!/^[a-zA-Z0-9_-]{1,64}$/.test(epoch??''))denied('MDB_RECOVERY_EPOCH');return (ACCEPTOR_SCHEMA+'\n'+SHARD_SCHEMA).replace(/\bmdb_(membership|acceptor|blob_shard)\b/g,`${recoveryPrefix(epoch)}mdb_$1`);}
export function validateRecoveryPlan(plan) {
 if(plan?.version!==1||plan.sourceState!=='unconfirmed'||typeof plan.epoch!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(plan.epoch)||
   typeof plan.cutoverId!=='string'||!/^[a-f0-9]{32}$/.test(plan.cutoverId)||typeof plan.controlId!=='string'||!/^\d{16,22}$/.test(plan.controlId)||
   !Array.isArray(plan.retiredEpochs)||!plan.retiredEpochs.length||plan.retiredEpochs.includes(plan.epoch)||plan.retiredEpochs.some(e=>typeof e!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(e))||
   !Array.isArray(plan.guilds)||!plan.guilds.length||plan.guilds.length>10000||new Set(plan.guilds).size!==plan.guilds.length||plan.guilds.some(g=>typeof g!=='string'||!/^\d{16,22}$/.test(g)))denied('MDB_RECOVERY_PLAN');
 if(plan.schemaChecksum!==checksum(recoverySchema(plan.epoch)))denied('MDB_RECOVERY_SCHEMA_CHECKSUM');
 return checksum(plan);
}
export function validateRecoveryEvidence(plan,evidence,now=Date.now()) {
 const hash=validateRecoveryPlan(plan),at=Date.parse(evidence?.verifiedAt??'');
 if(evidence?.planChecksum!==hash||!Number.isFinite(at)||at>now||now-at>86400_000||
   !['allWritersInventoried','discordPunishersDrained','legacySqlWriteAccessRevoked','oldDeploymentsFenced','localStateRestorable','legacyDataRetained'].every(k=>evidence[k]===true)||
   !/^[a-f0-9]{64}$/.test(evidence.localStateBackupChecksum??'')||!/^[a-f0-9]{64}$/.test(evidence.fenceRecordChecksum??''))denied('MDB_RECOVERY_FENCE_EVIDENCE');
 return hash;
}
// Management only. No snapshot is invented; old tables are never read/written.
// The reviewed certificate attests EXTERNAL writer shutdown/credential fencing.
// SQL alone cannot attest Discord processes or unknown hosts. Never auto-issue it.
export async function bootstrapUnconfirmedRecovery({providers,plan,evidence,approval,now=Date.now()}) {
 const hash=validateRecoveryEvidence(plan,evidence,now);
 if(approval!==hash||providers.length!==3||providers.some(p=>p.tablePrefix!==recoveryPrefix(plan.epoch)))denied('MDB_RECOVERY_APPROVAL');
 const c=createCoordinator({providers:providers.map(p=>quarantineVoter(p,new Set(['neon']))),epoch:plan.epoch});
 // Explicit 2-of-3 first bootstrap, not a health-driven authority promotion.
 const peers=providers.filter(p=>['supabase','turso'].includes(p.id));
 if(peers.length!==2||new Set(peers.map(p=>p.id)).size!==2)denied('MDB_RECOVERY_VOTERS');
 await Promise.all(peers.map(p=>p.initializeMembership(c.membership)));
 const records=c.scoped('recovery');let old;
 try{old=await records.read(plan.controlId);}catch(e){if(e.code!=='MDB_NOT_ENROLLED')throw e;}
 const certificate={planChecksum:hash,fenceRecordChecksum:evidence.fenceRecordChecksum,sourceState:'unconfirmed',retiredEpochs:plan.retiredEpochs,guilds:plan.guilds,quarantined:['neon']};
 if(old&&canonical(old.value.data)!==canonical(certificate))denied('MDB_RECOVERY_CONFLICT');
 if(!old)await records.update({guildId:plan.controlId,expectedRevision:0,expectedChecksum:'GENESIS',requestId:`recovery:${plan.cutoverId}`,actorId:'approved-recovery',action:'epoch:recovery',data:certificate});
 const security=createSecurityService(c);
 let complete=0;
 for(const guildId of plan.guilds){let state;try{state=await security.read(guildId);}catch(e){if(e.code!=='MDB_NOT_ENROLLED')throw e;}
  if(state&&state.value.data.recoveryId!==hash)denied('MDB_RECOVERY_CONFLICT');
  if(!state)await security.enrollUnconfirmed({guildId,actorId:'approved-recovery',requestId:`recover:${plan.cutoverId}`,recoveryId:hash,verifyFence:async()=>validateRecoveryEvidence(plan,evidence,now)===hash});
  complete++;
 }
 return{epoch:plan.epoch,tablePrefix:recoveryPrefix(plan.epoch),planChecksum:hash,complete,quorum:'2/3',quarantined:['neon'],sourceState:'unconfirmed',coordinator:c,security};
}
