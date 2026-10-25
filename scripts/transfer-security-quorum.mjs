import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { validateTransferPlan,stageTransfer,resumeTransfer } from '../lib/multi-db/transfer.mjs';
import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
import { initializeRuntimeOwner } from '../lib/multi-db/runtime-owner.mjs';

const option=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
let client,runtime;
try {
 const path=option('plan');if(!path)throw Error('MDB_TRANSFER_PLAN_REQUIRED');
 const plan=JSON.parse(readFileSync(path,'utf8')),hash=validateTransferPlan(plan);
 if(!process.argv.includes('--execute-reviewed-plan')){
  console.log(JSON.stringify({mode:'PLAN_ONLY',epoch:plan.epoch,guildCount:plan.guilds.length,planChecksum:hash,
   gates:['restore-verified fresh backup','all old Discord punishers stopped/drained','all old SQL writers fenced','same exact plan on crash resume'],productionMutation:false}));
 }else{
  if(process.env.SECURITY_QUORUM_TRANSFER_APPROVED!==hash||process.env.SECURITY_V2_AUTO_EXECUTION==='enabled')throw Error('MDB_TRANSFER_APPROVAL_REQUIRED');
  const evidence=JSON.parse(readFileSync(option('evidence'),'utf8'));
  if(evidence.planChecksum!==hash||evidence.restoreVerified!==true||evidence.oldPunishersDrained!==true||evidence.oldSqlWritersInventoried!==true||
    typeof evidence.backupPath!=='string'||createHash('sha256').update(readFileSync(evidence.backupPath)).digest('hex')!==evidence.backupChecksum||
    !Number.isFinite(Date.parse(evidence.verifiedAt))||Date.now()-Date.parse(evidence.verifiedAt)<0||Date.now()-Date.parse(evidence.verifiedAt)>86400000)throw Error('MDB_TRANSFER_EVIDENCE_REQUIRED');
  // Evidence is an explicit human-reviewed deployment approval artifact. It
  // does not magically attest remote processes; never auto-create it.
  const source=new URL(process.env.DATABASE_URL??'');
  if(source.hostname!==plan.sourceHost||decodeURIComponent(source.pathname.slice(1))!==plan.sourceDatabase)throw Error('MDB_TRANSFER_SOURCE_IDENTITY');
  if(process.env.WEB_AUTH_SUPABASE_DATABASE_URL&&new URL(process.env.WEB_AUTH_SUPABASE_DATABASE_URL).hostname===source.hostname)throw Error('MDB_AUTH_DATABASE_FORBIDDEN');
  client=new pg.Client({connectionString:source.href,connectionTimeoutMillis:5000});await client.connect();
  runtime=await createSecurityCoordinatorRuntime();if(!runtime)throw Error('MDB_CONFIGURATION');
  if(process.argv.includes('--initialize-membership'))await runtime.coordinator.initializeMembership(plan.membershipApproval);
  await client.query('BEGIN');try{await client.query("SET LOCAL lock_timeout='5s'");await client.query("SET LOCAL statement_timeout='30s'");await stageTransfer(client,plan);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}
  const result=await resumeTransfer(client,runtime,plan);
  if(plan.runtimeApplicationId)await initializeRuntimeOwner(runtime.coordinator,plan.runtimeApplicationId,`owner:${hash.slice(0,48)}`);
  console.log(JSON.stringify(result));
 }
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_TRANSFER_UNAVAILABLE'}));process.exitCode=1;}
finally{await runtime?.close();await client?.end();}
