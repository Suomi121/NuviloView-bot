import { DEFAULT_GUILD_SPAM_POLICY } from '../guild-spam-policy.mjs';
import { denied } from './coordinator.mjs';
export const RECOVERY_FIELDS = ['policy','autoTimeout','emergencyStop','operatorRoleIds','logChannelId'];
export function securityVerification(data) {
  return data.verification ?? Object.fromEntries(RECOVERY_FIELDS.map(k=>[k,true]));
}
export function validateRecoveryState(data) {
  if (!Object.hasOwn(data,'verification')) {
    if (data.recoveryId !== undefined || data.migrationState !== 'complete') denied('MDB_INVALID_SECURITY_STATE');
    return;
  }
  if (!data.verification || typeof data.verification!=='object'||Array.isArray(data.verification)||!/^[a-f0-9]{64}$/.test(data.recoveryId??'') ||
      Object.keys(data.verification).sort().join(',') !== [...RECOVERY_FIELDS].sort().join(',') ||
      RECOVERY_FIELDS.some(k=>typeof data.verification[k]!=='boolean')) denied('MDB_INVALID_SECURITY_STATE');
  const known=Object.values(data.verification).filter(Boolean).length;
  if(data.migrationState!==(known===5?'complete':known===0?'unconfirmed':'partial'))denied('MDB_INVALID_SECURITY_STATE');
  if(!data.verification.autoTimeout&&data.autoTimeout!==false)denied('MDB_UNKNOWN_CONSENT');
  if(!data.verification.emergencyStop&&data.emergencyStop!==true)denied('MDB_UNKNOWN_EMERGENCY');
  if(!data.verification.operatorRoleIds&&data.operatorRoleIds.length)denied('MDB_UNKNOWN_OPERATOR');
  if(!data.verification.logChannelId&&data.logChannelId!==null)denied('MDB_UNKNOWN_LOG_DESTINATION');
}
// Effective guards/editable defaults only: verification explicitly says these
// are NOT the previous Guild values or restored consent.
export function unconfirmedSecurityState(recoveryId) {
  return {policy:structuredClone(DEFAULT_GUILD_SPAM_POLICY),autoTimeout:false,emergencyStop:true,
    operatorRoleIds:[],logChannelId:null,migrationState:'unconfirmed',recoveryId,
    verification:Object.fromEntries(RECOVERY_FIELDS.map(k=>[k,false]))};
}
export function confirmRecoveryField(data,field) {
  if(!data.verification)return;
  data.verification[field]=true;
  data.migrationState=Object.values(data.verification).every(Boolean)?'complete':'partial';
}
export function automaticKnowledgeConfirmed(data) {
  const v=securityVerification(data);return v.policy&&v.autoTimeout&&v.emergencyStop;
}
