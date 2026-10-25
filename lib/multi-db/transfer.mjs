import { checksum, canonical, denied } from './coordinator.mjs';
import { validateSecurityData } from './security-service.mjs';
import { DEFAULT_GUILD_SPAM_POLICY, parseGuildSpamPolicyRow } from '../guild-spam-policy.mjs';

export function validateTransferPlan(plan) {
 if(plan?.version!==1||!/^[a-zA-Z0-9_-]{1,64}$/.test(plan.epoch??'')||!Array.isArray(plan.guilds)||!plan.guilds.length||plan.guilds.length>10000||
  new Set(plan.guilds.map(g=>g.guildId)).size!==plan.guilds.length)denied('MDB_TRANSFER_PLAN');
 if((plan.runtimeApplicationId!==undefined&&!/^\d{16,22}$/.test(plan.runtimeApplicationId))||
  (plan.membershipApproval!==undefined&&!/^[a-f0-9]{64}$/.test(plan.membershipApproval)))denied('MDB_TRANSFER_PLAN');
 for(const g of plan.guilds){if(!/^\d{16,22}$/.test(g.guildId??'')||checksum(g.snapshot)!==g.checksum)denied('MDB_TRANSFER_SNAPSHOT');validateSecurityData(g.snapshot);}
 return checksum(plan);
}
export async function snapshotLegacy(client,guildIds) {
 const stop=(await client.query('SELECT emergency_stop FROM security_v2_control WHERE singleton=true')).rows[0];
 if(typeof stop?.emergency_stop!=='boolean')denied('MDB_TRANSFER_CONTROL_MISSING');
 const result=[];
 for(const guildId of guildIds){
  if(!/^\d{16,22}$/.test(guildId))denied('MDB_INVALID_GUILD');
  if((await client.query('SELECT 1 FROM guild_spam_policy_authority WHERE guild_id=$1',[guildId])).rowCount)denied('MDB_SQLITE_AUTHORITY_REQUIRES_SEPARATE_EXPORT');
  const enrollment=(await client.query(`SELECT e.migration_state,e.detection_policy_seen,a.enabled
    FROM guild_security_v2_enrollment e LEFT JOIN guild_security_v2_auto a USING(guild_id) WHERE e.guild_id=$1`,[guildId])).rows[0];
  if(enrollment?.migration_state!=='complete'||typeof enrollment.enabled!=='boolean')denied('MDB_TRANSFER_CONSENT_UNKNOWN');
  const row=(await client.query('SELECT * FROM guild_spam_policy WHERE guild_id=$1',[guildId])).rows[0];
  if(!row&&(enrollment.detection_policy_seen||(await client.query('SELECT 1 FROM guild_spam_policy_audit WHERE guild_id=$1 LIMIT 1',[guildId])).rowCount))denied('MDB_TRANSFER_POLICY_MISSING');
  const role=(await client.query('SELECT role_ids FROM guild_security_operator WHERE guild_id=$1',[guildId])).rows[0];
  const log=(await client.query('SELECT channel_id FROM guild_security_log WHERE guild_id=$1',[guildId])).rows[0];
  const snapshot={policy:row?parseGuildSpamPolicyRow(row):structuredClone(DEFAULT_GUILD_SPAM_POLICY),autoTimeout:enrollment.enabled,
   emergencyStop:stop.emergency_stop,migrationState:'complete',operatorRoleIds:role?.role_ids??[],logChannelId:log?.channel_id??null};
  validateSecurityData(snapshot);result.push({guildId,snapshot,checksum:checksum(snapshot)});
 }
 return result;
}
// Caller owns BEGIN/COMMIT. A committed snapshot and the SQL fence are atomic.
// No external bot process is stopped here. Draining Discord punishers is a
// separate mandatory deployment interlock, not something SQL can prove.
export async function stageTransfer(client,plan) {
 const hash=validateTransferPlan(plan);
 if((await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows[0]?.isolation!=='read committed')denied('MDB_TRANSFER_ISOLATION');
 await client.query('LOCK TABLE guild_spam_policy,guild_security_v2_auto,guild_security_v2_enrollment,guild_security_operator,guild_security_log,security_v2_control,guild_security_quorum_fence,guild_quorum_transfer IN SHARE ROW EXCLUSIVE MODE');
 const guards=(await client.query(`SELECT tgname,tgenabled,tgtype,c.relname,p.proname,n.nspname
  FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname=current_schema()`)).rows;
 for(const [name,table] of [['quorum_policy_writer','guild_spam_policy'],['quorum_auto_writer','guild_security_v2_auto'],['quorum_enrollment_writer','guild_security_v2_enrollment'],['quorum_operator_writer','guild_security_operator'],['quorum_log_writer','guild_security_log'],['quorum_control_writer','security_v2_control']])
  if(!guards.some(g=>g.tgname===name&&g.relname===table&&Number(g.tgtype)===31&&['O','A'].includes(g.tgenabled)&&g.proname==='guard_security_quorum_writer'))denied('MDB_TRANSFER_FENCE_MISSING');
 for(const g of plan.guilds){
  const old=(await client.query('SELECT * FROM guild_quorum_transfer WHERE guild_id=$1',[g.guildId])).rows[0];
  if(old){if(old.plan_checksum!==hash||old.epoch!==plan.epoch||old.snapshot_checksum!==g.checksum)denied('MDB_TRANSFER_CONFLICT');continue;}
  const live=(await snapshotLegacy(client,[g.guildId]))[0];if(live.checksum!==g.checksum)denied('MDB_TRANSFER_SOURCE_CHANGED');
  await client.query('INSERT INTO guild_security_quorum_fence(guild_id,epoch,snapshot_checksum) VALUES($1,$2,$3)',[g.guildId,plan.epoch,g.checksum]);
  await client.query(`INSERT INTO guild_quorum_transfer(guild_id,epoch,plan_checksum,snapshot,snapshot_checksum,state)
   VALUES($1,$2,$3,$4,$5,'fenced')`,[g.guildId,plan.epoch,hash,canonical(g.snapshot),g.checksum]);
 }
 return hash;
}
export async function resumeTransfer(client,runtime,plan) {
 const hash=validateTransferPlan(plan);if(runtime.coordinator.epoch!==plan.epoch)denied('MDB_TRANSFER_EPOCH');
 let complete=0;
 for(const g of plan.guilds){
  const verify=async()=>{
   const r=(await client.query(`SELECT t.*,f.epoch AS fence_epoch,f.snapshot_checksum AS fence_checksum
    FROM guild_quorum_transfer t JOIN guild_security_quorum_fence f USING(guild_id) WHERE t.guild_id=$1`,[g.guildId])).rows[0];
   if(!r||r.plan_checksum!==hash||r.epoch!==plan.epoch||r.fence_epoch!==plan.epoch||r.snapshot_checksum!==g.checksum||r.fence_checksum!==g.checksum||checksum(JSON.parse(r.snapshot))!==g.checksum)denied('MDB_TRANSFER_NOT_FENCED');
   return true;
  };
  await verify();
  const chosen=await runtime.security.importFenced({guildId:g.guildId,actorId:'approved-transfer',requestId:`import:${hash.slice(0,48)}`,snapshot:g.snapshot,verifyFence:verify});
  if(checksum(chosen.value.data)!==g.checksum)denied('MDB_TRANSFER_VERIFY_FAILED');
  await client.query("UPDATE guild_quorum_transfer SET state='complete' WHERE guild_id=$1 AND plan_checksum=$2",[g.guildId,hash]);complete++;
 }
 return {complete,total:plan.guilds.length,planChecksum:hash};
}
