import { denied } from './coordinator.mjs';

// Not a wall-clock lease: no TTL takeover or promotion based on a failed ping.
// Ownership is initialized only by an approved transfer after ALL old Bot
// instances have been drained. Crash recovery never guesses the old owner died.
export class QuorumRuntimeOwner {
 constructor({coordinator,applicationId,identity,config,onLeaseLost,repository=null,heartbeatData=()=>({})}){
  if(!/^\d{16,22}$/.test(applicationId??'')||!identity?.instanceId||!identity?.hostId)denied('MDB_RUNTIME_IDENTITY');
  this.c=coordinator.scoped('runtime-owner');this.id=applicationId;this.identity=identity;this.config=config;this.onLeaseLost=onLeaseLost;
  this.leaseState='Acquiring';this.status='Starting';this.timer=null;this.active=null;this.lost=false;
  this.repository=repository;this.heartbeatData=heartbeatData;this.stopping=false;this.heartbeatState='NOT_RECORDED';
 }
 async acquire(){
  const old=await this.c.read(this.id);
  if(old.value.data.owner&&old.value.data.owner.instanceId!==this.identity.instanceId){this.leaseState='Contended';return{acquired:false,owner:old.value.data.owner};}
  if(!old.value.data.owner)await this.c.update({guildId:this.id,expectedRevision:old.value.revision,expectedChecksum:old.checksum,
   actorId:this.identity.instanceId,requestId:`acquire:${this.identity.instanceId}`,action:'runtime:acquire',
   data:{owner:{instanceId:this.identity.instanceId,hostId:this.identity.hostId},generation:old.value.data.generation+1}});
  this.leaseState='Owned';return{acquired:true};
 }
 async start(){await this.prove();this.timer=setInterval(()=>void this.recordNow(),this.config.renewSeconds*1000);this.timer.unref();}
 async prove(){const state=await this.c.read(this.id);if(state.value.data.owner?.instanceId!==this.identity.instanceId)denied('MDB_RUNTIME_FENCED');this.fencingToken=state.fencingToken;return state;}
 setStatus(status,leaseState=this.leaseState){this.status=status;this.leaseState=leaseState;}
 async heartbeat(overrides={}){
  if(!this.repository)return;
  try{const dynamic=await this.heartbeatData();await this.repository.writeHeartbeat({...this.identity,serviceKey:this.config.serviceKey,
   // Legacy numeric Neon fence must never be confused with a quorum fence.
   fencingToken:null,status:overrides.status??this.status,leaseState:this.leaseState,guildCount:dynamic.guildCount??0,
   metadata:{...(dynamic.metadata??{}),authority:'cloud-quorum',quorumFencingToken:this.fencingToken},stoppedAt:overrides.stoppedAt??null});this.heartbeatState='RECORDED';}
  catch{this.heartbeatState='LEGACY_MONITOR_UNAVAILABLE';} // advisory only; not the ownership proof
 }
 async recordNow(){
  if(this.lost||this.stopping)return;if(this.active)return this.active;
  this.active=(async()=>{try{await this.prove();}catch{this.lost=true;this.leaseState='Lost';await this.onLeaseLost?.();return;}if(!this.stopping)await this.heartbeat();})();
  try{await this.active;}finally{this.active=null;}
 }
 async stop({release=true,finalStatus='Stopped'}={}){
  clearInterval(this.timer);this.stopping=true;this.status=finalStatus;
  if(release&&this.active)await this.active;
  // Caller disconnects Discord/drains side effects BEFORE releasing ownership.
  if(release&&!this.lost){try{const old=await this.prove();await this.c.update({guildId:this.id,expectedRevision:old.value.revision,expectedChecksum:old.checksum,
   actorId:this.identity.instanceId,requestId:`release:${this.identity.instanceId}`,action:'runtime:release',data:{owner:null,generation:old.value.data.generation}});this.leaseState='Released';}
   catch{this.leaseState='Unknown';}}
  await this.heartbeat({status:finalStatus,stoppedAt:new Date()});
 }
}
export async function initializeRuntimeOwner(coordinator,applicationId,requestId){
 if(!/^\d{16,22}$/.test(applicationId??''))denied('MDB_RUNTIME_IDENTITY');
 return coordinator.scoped('runtime-owner').update({guildId:applicationId,expectedRevision:0,expectedChecksum:'GENESIS',
  actorId:'approved-transfer',requestId,action:'runtime:initialize',data:{owner:null,generation:0}});
}
