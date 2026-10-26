import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateRecoveryPlan,validateRecoveryEvidence,recoverySchema,recoveryPrefix,bootstrapUnconfirmedRecovery} from '../lib/multi-db/recovery-bootstrap.mjs';
import {createSecurityCoordinatorRuntime} from '../lib/multi-db/runtime.mjs';
import {checksum,denied} from '../lib/multi-db/coordinator.mjs';
const option=name=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
let runtime;
try{
 const plan=JSON.parse(readFileSync(option('plan'),'utf8')),hash=validateRecoveryPlan(plan);
 if(!process.argv.includes('--execute-reviewed-recovery')){
  console.log(JSON.stringify({mode:'PLAN_ONLY',epoch:plan.epoch,planChecksum:hash,tablePrefix:recoveryPrefix(plan.epoch),schemaChecksum:checksum(recoverySchema(plan.epoch)),guildCount:plan.guilds.length,sourceState:'unconfirmed',requires:'external old-writer credential fencing + drained Discord punishers + restorable local state; no legacy snapshot needed',productionMutation:false}));
 }else{
  const evidence=JSON.parse(readFileSync(option('evidence'),'utf8'));
  validateRecoveryEvidence(plan,evidence);
  if(process.env.SECURITY_QUORUM_RECOVERY_APPROVED!==hash)denied('MDB_RECOVERY_APPROVAL');
  const fileHash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  if(fileHash(option('backup'))!==evidence.localStateBackupChecksum||fileHash(option('fence-record'))!==evidence.fenceRecordChecksum)denied('MDB_RECOVERY_ARTIFACT_CHECKSUM');
  if(process.env.SECURITY_COORDINATOR_EPOCH!==plan.epoch||process.env.SECURITY_COORDINATOR_TABLE_PREFIX!==recoveryPrefix(plan.epoch)||process.env.SECURITY_V2_AUTO_EXECUTION==='enabled')denied('MDB_RECOVERY_CONFIGURATION');
  runtime=await createSecurityCoordinatorRuntime(process.env,{management:true});if(!runtime)denied('MDB_CONFIGURATION');
  if(process.argv.includes('--install-reviewed-schema'))await runtime.installReviewedRecoverySchema(checksum(recoverySchema(plan.epoch)));
  // Explicit management DDL only; request handlers never install schema.
  const result=await bootstrapUnconfirmedRecovery({providers:runtime.managementProviders,plan,evidence,approval:hash});
  console.log(JSON.stringify({epoch:result.epoch,planChecksum:hash,complete:result.complete,quarantined:result.quarantined,sourceState:result.sourceState}));
 }
 if(process.argv.includes('--print-schema'))console.log(recoverySchema(plan.epoch));
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_RECOVERY_UNAVAILABLE'}));process.exitCode=1;}
finally{await runtime?.close();}
