import { readFileSync } from 'node:fs';
import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
import { checksum } from '../lib/multi-db/coordinator.mjs';
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
let runtime;
try{
 const applicationId=arg('application');if(!/^\d{16,22}$/.test(applicationId??''))throw Error('MDB_RUNTIME_IDENTITY');
 runtime=await createSecurityCoordinatorRuntime();if(!runtime)throw Error('MDB_CONFIGURATION');
 const c=runtime.coordinator.scoped('runtime-owner'),old=await c.read(applicationId);
 const plan={applicationId,epoch:runtime.coordinator.epoch,revision:old.value.revision,checksum:old.checksum},planChecksum=checksum(plan);
 if(!process.argv.includes('--execute-drained-release'))console.log(JSON.stringify({mode:'PLAN_ONLY',...plan,planChecksum,ownerPresent:!!old.value.data.owner}));
 else{
  const evidence=JSON.parse(readFileSync(arg('evidence'),'utf8'));
  if(process.env.SECURITY_QUORUM_HANDOFF_APPROVED!==planChecksum||evidence.planChecksum!==planChecksum||evidence.oldPunishersDrained!==true||
   !Number.isFinite(Date.parse(evidence.verifiedAt))||Date.now()-Date.parse(evidence.verifiedAt)<0||Date.now()-Date.parse(evidence.verifiedAt)>3600000)throw Error('MDB_HANDOFF_DRAIN_APPROVAL_REQUIRED');
  await c.update({guildId:applicationId,expectedRevision:old.value.revision,expectedChecksum:old.checksum,actorId:'approved-handoff',requestId:`handoff:${planChecksum}`,
   action:'runtime:drained-release',data:{owner:null,generation:old.value.data.generation}});
  console.log(JSON.stringify({result:'RELEASED',applicationId,planChecksum,startsBot:false}));
 }
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_HANDOFF_UNAVAILABLE'}));process.exitCode=1;}
finally{await runtime?.close();}
