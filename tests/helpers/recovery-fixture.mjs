import {DatabaseSync} from 'node:sqlite';
import {createSqlAcceptor,ACCEPTOR_SCHEMA} from '../../lib/multi-db/acceptor.mjs';
import {bootstrapUnconfirmedRecovery,recoverySchema,recoveryPrefix,validateRecoveryPlan} from '../../lib/multi-db/recovery-bootstrap.mjs';
import {checksum} from '../../lib/multi-db/coordinator.mjs';
export const recoveryGuild='100000000000000001',recoveryActor='100000000000000003';
export const recoveryPlan=()=>({version:1,epoch:'isolated-recovery-20261026',schemaChecksum:checksum(recoverySchema('isolated-recovery-20261026')),cutoverId:'a'.repeat(32),controlId:'100000000000000009',retiredEpochs:['legacy-unknown'],guilds:[recoveryGuild],sourceState:'unconfirmed'});
export const recoveryEvidence=plan=>({planChecksum:validateRecoveryPlan(plan),verifiedAt:new Date().toISOString(),allWritersInventoried:true,discordPunishersDrained:true,legacySqlWriteAccessRevoked:true,oldDeploymentsFenced:true,localStateRestorable:true,legacyDataRetained:true,localStateBackupChecksum:'b'.repeat(64),fenceRecordChecksum:'c'.repeat(64)});
export async function recoveryFixture(t,{bootstrap=true}={}){
 const plan=recoveryPlan(),evidence=recoveryEvidence(plan),dbs=[],faults={neon:true};
 const providers=['neon','supabase','turso'].map(id=>{
  const db=new DatabaseSync(':memory:');db.exec(ACCEPTOR_SCHEMA);db.exec(recoverySchema(plan.epoch));dbs.push(db);
  db.prepare('INSERT INTO mdb_membership VALUES(1,?,?)').run('unmodified-legacy-membership',id);
  return createSqlAcceptor({id,dialect:'sqlite',tablePrefix:recoveryPrefix(plan.epoch),execute:async(sql,args)=>{
   if(faults[id])throw new Error('ISOLATED_OFFLINE');return db.prepare(sql).all(...args);
  }});
 });
 t.after(()=>dbs.forEach(d=>d.close()));
 const args={providers,plan,evidence,approval:validateRecoveryPlan(plan)};
 const result=bootstrap?await bootstrapUnconfirmedRecovery(args):null;
 const change=async(operation,value=null,options={})=>{
  const state=await result.security.read(recoveryGuild);
  return result.security.change({guildId:recoveryGuild,actorId:recoveryActor,requestId:`request:${state.value.revision}:${operation}`,expectedRevision:state.value.revision,expectedChecksum:state.checksum,operation,value,authorize:async()=>true,...options});
 };
 return{args,plan,evidence,dbs,providers,faults,...result,change};
}
