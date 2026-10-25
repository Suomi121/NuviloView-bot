import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
let runtime;
try{
 const guildId=arg('guild');if(!/^\d{16,22}$/.test(guildId??''))throw Error('MDB_INVALID_GUILD');
 runtime=await createSecurityCoordinatorRuntime();if(!runtime)throw Error('MDB_CONFIGURATION');
 if(!process.argv.includes('--execute-checkpoint'))console.log(JSON.stringify({mode:'PLAN_ONLY',observed:await runtime.coordinator.inspect(guildId),deletesData:false}));
 else{
  if(process.env.SECURITY_QUORUM_MAINTENANCE_APPROVED!==runtime.coordinator.epoch||!/^[a-f0-9]{64}$/.test(process.env.SECURITY_ARCHIVE_KEY??''))throw Error('MDB_CHECKPOINT_APPROVAL_REQUIRED');
  const result=await runtime.coordinator.checkpoint({guildId,archive:runtime.dataPlane,key:Buffer.from(process.env.SECURITY_ARCHIVE_KEY,'hex'),keyId:process.env.SECURITY_ARCHIVE_KEY_ID,
   actorId:'approved-maintenance',requestId:arg('request')});
  console.log(JSON.stringify({checkpoint:'COMMITTED',revision:result.value.data.base.value.revision,archiveChecksum:result.value.data.manifestChecksum,deletesData:false}));
 }
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_CHECKPOINT_UNAVAILABLE'}));process.exitCode=1;}
finally{await runtime?.close();}
