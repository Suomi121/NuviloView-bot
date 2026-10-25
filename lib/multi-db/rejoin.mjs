import { randomBytes } from 'node:crypto';
import { createCoordinator,denied,checksum } from './coordinator.mjs';

export function quarantineVoter(provider,quarantined){
 if(!quarantined.has(provider.id))return provider;
 const refuse=async()=>denied('MDB_PROVIDER_QUARANTINED');
 return {...provider,load:refuse,prepare:refuse,accept:refuse,listGuilds:refuse,resources:refuse,initializeMembership:refuse,
  withNamespace:scope=>quarantineVoter(provider.withNamespace(scope),quarantined)};
}
// Operator-driven restore/rejoin. The restored voter MUST remain quarantined
// on every Writer until this completes. Never trust its old disk as a vote.
// Divergent accepted records are retained and require manual review, not erased.
export async function rejoinVoter({providers,epoch,targetId}){
 if(!['neon','supabase','turso'].includes(targetId))denied('MDB_REJOIN_TARGET');
 const quarantine=new Set([targetId]),safe=providers.map(p=>quarantineVoter(p,quarantine));
 const base=createCoordinator({providers:safe,epoch,maxSlots:100000});
 const peers=providers.filter(p=>p.id!==targetId),target=providers.find(p=>p.id===targetId);
 const inventories=await Promise.all(peers.map(p=>p.resources(base.membership)));
 const resources=[...new Set(inventories.flat())].sort();
 const targetInventory=await target.resources(base.membership);
 if(targetInventory.some(k=>!resources.includes(k)))denied('MDB_REJOIN_DIVERGENT_RESOURCE');
 let restored=0;
 for(const resource of resources){
  const match=/^(?:@([a-z0-9:-]{1,160}):)?(\d{16,22})$/.exec(resource);if(!match)denied('MDB_REJOIN_RESOURCE');
  const [,scope,guild]=match,ps=scope?safe.map(p=>p.withNamespace(scope)):safe;
  const c=createCoordinator({providers:ps,epoch,maxSlots:100000});
  const recovered=await c.recover(guild),destination=scope?target.withNamespace(scope):target;
  const old=await destination.load(c.membership,guild);
  if(old.some(r=>r.accepted_ballot&&Number(r.slot)>=recovered.slot))denied('MDB_REJOIN_DIVERGENT_TAIL');
  let counter=old.reduce((n,r)=>{const b=BigInt(`0x${r.promised.slice(0,16)}`);return b>n?b:n;},0n);
  const writer=randomBytes(16).toString('hex');
  for(const chosen of recovered.history){
   counter++;if(counter>0xffffffffffffffffn)denied('MDB_BALLOT_EXHAUSTED');
   const ballot=`${counter.toString(16).padStart(16,'0')}:${writer}`,slot=chosen.value.revision;
   const promise=await destination.prepare(c.membership,guild,slot,ballot);
   if(!promise||promise.promised!==ballot)denied('MDB_REJOIN_FENCED');
   if(promise.acceptedBallot&&(promise.checksum!==chosen.checksum||checksum(promise.value)!==chosen.checksum))denied('MDB_REJOIN_CONFLICT');
   if(!await destination.accept(c.membership,guild,slot,ballot,chosen.value,chosen.checksum))denied('MDB_REJOIN_FENCED');
   restored++;
  }
 }
 return {state:'CATCHUP_VERIFIED',resources:resources.length,restored,quarantineStillRequired:true,
  next:'review evidence then remove quarantine consistently; no automatic membership or runtime configuration change'};
}
