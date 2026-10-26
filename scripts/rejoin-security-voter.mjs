import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
import { rejoinVoter } from '../lib/multi-db/rejoin.mjs';
let runtime;
try{
 const targetId=process.argv.find(a=>a.startsWith('--provider='))?.slice(11);
 if(!['neon','supabase','turso'].includes(targetId))throw Error('MDB_REJOIN_TARGET');
 if(!process.argv.includes('--execute-quarantined-catchup'))console.log(JSON.stringify({mode:'PLAN_ONLY',targetId,
  gates:['quarantine target on ALL Writers','two original healthy voters','restored membership unchanged','retain conflicts for manual review'],configurationChanged:false}));
 else{
  runtime=await createSecurityCoordinatorRuntime({...process.env,SECURITY_COORDINATOR_QUARANTINED_PROVIDERS:targetId});
  if(!runtime||process.env.SECURITY_QUORUM_MAINTENANCE_APPROVED!==runtime.coordinator.epoch)throw Error('MDB_REJOIN_APPROVAL_REQUIRED');
  console.log(JSON.stringify(await rejoinVoter({providers:runtime.managementProviders,epoch:runtime.coordinator.epoch,targetId})));
 }
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_REJOIN_UNAVAILABLE'}));process.exitCode=1;}
finally{await runtime?.close();}
