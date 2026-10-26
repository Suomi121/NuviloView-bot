import {createSecurityCoordinatorRuntime} from '../lib/multi-db/runtime.mjs';
import {checksum,denied} from '../lib/multi-db/coordinator.mjs';
const option=name=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
let runtime;
try{
 const guildId=option('guild'),operation=option('operation');
 if(!/^\d{16,22}$/.test(guildId??'')||!['emergency:on','emergency:off'].includes(operation))denied('MDB_RECOVERY_ARGUMENTS');
 runtime=await createSecurityCoordinatorRuntime();if(!runtime?.coordinator.recovery)denied('MDB_RECOVERY_CONFIGURATION');
 const current=await runtime.security.read(guildId);
 const intent={epoch:current.value.epoch,guildId,operation,revision:current.value.revision,checksum:current.checksum,recoveryId:current.value.data.recoveryId};
 const approval=checksum(intent);
 if(!process.argv.includes('--execute-reviewed-confirmation'))console.log(JSON.stringify({mode:'PLAN_ONLY',...intent,approval,autoTimeoutWillChange:false,readPerformsConsensusPromises:true}));
 else{
  if(process.env.SECURITY_QUORUM_EMERGENCY_CONFIRM_APPROVED!==approval)denied('MDB_RECOVERY_APPROVAL');
  const state=await runtime.security.change({guildId,actorId:'approved-emergency-review',requestId:`review:${approval.slice(0,48)}`,expectedEpoch:intent.epoch,expectedRevision:intent.revision,expectedChecksum:intent.checksum,operation,value:null,acknowledgeRecovery:intent.recoveryId,authorize:async()=>process.env.SECURITY_QUORUM_EMERGENCY_CONFIRM_APPROVED===approval});
  console.log(JSON.stringify({epoch:state.value.epoch,revision:state.value.revision,emergencyConfirmed:true,autoTimeoutChanged:false}));
 }
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_RECOVERY_CONFIRMATION_UNAVAILABLE'}));process.exitCode=1;}
finally{await runtime?.close();}
