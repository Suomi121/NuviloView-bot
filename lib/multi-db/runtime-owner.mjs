import { denied } from './coordinator.mjs';

// Not a wall-clock lease: no TTL takeover or promotion based on a failed ping.
// Ownership is initialized only by an approved transfer after ALL old Bot
// instances have been drained. Crash recovery never guesses the old owner died.
export class QuorumRuntimeOwner {
 constructor({coordinator,applicationId,identity,config,onLeaseLost}){
  if(!/^\d{16,22}$/.test(applicationId??'')||!identity?.instanceId||!identity?.hostId)denied('MDB_RUNTIME_IDENTITY');
  this.c=coordinator.scoped('runtime-owner');this.id=applicationId;this.identity=identity;this.config=config;this.onLeaseLost=onLeaseLost;
  this.leaseState='Acquiring';this.status='Starting';this.timer=null;this.active=null;this.lost=false;
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
 async recordNow(){
  if(this.lost)return;if(this.active)return this.active;
  this.active=(async()=>{try{await this.prove();}catch{this.lost=true;this.leaseState='Lost';await this.onLeaseLost?.();}})();
  try{await this.active;}finally{this.active=null;}
 }
 async stop({release=true,finalStatus='Stopped'}={}){
  clearInterval(this.timer);this.status=finalStatus;
  // Caller disconnects Discord/drains side effects BEFORE releasing ownership.
  if(release&&!this.lost){try{const old=await this.prove();await this.c.update({guildId:this.id,expectedRevision:old.value.revision,expectedChecksum:old.checksum,
   actorId:this.identity.instanceId,requestId:`release:${this.identity.instanceId}`,action:'runtime:release',data:{owner:null,generation:old.value.data.generation}});this.leaseState='Released';}
   catch{this.leaseState='Unknown';}}
 }
}
export async function initializeRuntimeOwner(coordinator,applicationId,requestId){
 if(!/^\d{16,22}$/.test(applicationId??''))denied('MDB_RUNTIME_IDENTITY');
 return coordinator.scoped('runtime-owner').update({guildId:applicationId,expectedRevision:0,expectedChecksum:'GENESIS',
  actorId:'approved-transfer',requestId,action:'runtime:initialize',data:{owner:null,generation:0}});
}
