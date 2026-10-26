import { DEFAULT_GUILD_SPAM_POLICY, normalizeGuildSpamPolicy, applySpamProtectionCommand } from '../guild-spam-policy.mjs';
import { denied, checksum } from './coordinator.mjs';
import { randomUUID } from 'node:crypto';
import {securityVerification,validateRecoveryState,confirmRecoveryField,automaticKnowledgeConfirmed,unconfirmedSecurityState} from './recovery-state.mjs';

const id = v => typeof v === 'string' && /^\d{16,22}$/.test(v);
// One Guild aggregate serializes policy, explicit consent, operator delegation,
// emergency stop and log destination. They remain distinct data/authorization.
export function validateSecurityData(data) {
  if (!data || Object.keys(data).filter(k=>!['verification','recoveryId'].includes(k)).sort().join(',') !== 'autoTimeout,emergencyStop,logChannelId,migrationState,operatorRoleIds,policy' ||
      !normalizeGuildSpamPolicy(data.policy) ||
      typeof data.autoTimeout !== 'boolean' || typeof data.emergencyStop !== 'boolean' ||
      !Array.isArray(data.operatorRoleIds) || data.operatorRoleIds.length > 20 ||
      data.operatorRoleIds.some(v => !id(v)) ||
      (data.logChannelId !== null && !id(data.logChannelId))) denied('MDB_INVALID_SECURITY_STATE');
  validateRecoveryState(data);return data;
}

export function createSecurityService(coordinator) {
  async function read(guildId) {
    const state = await coordinator.read(guildId);
    validateSecurityData(state.value.data);
    return state;
  }
  async function change({ guildId, actorId, requestId, expectedRevision, expectedChecksum, expectedEpoch, operation, value, authorize, acknowledgeRecovery = null }) {
    // Caller supplies a fresh Discord/session authorization closure. No caller-
    // provided permissions, replica role caches or role names are trusted here.
    const current = await read(guildId);
    if(expectedEpoch!==undefined&&expectedEpoch!==current.value.epoch)denied('MDB_EPOCH_CONFLICT');
    if (current.value.revision !== expectedRevision || current.checksum !== expectedChecksum) denied('MDB_REVISION_CONFLICT');
    if (typeof authorize !== 'function' || await authorize(operation) !== true) denied('MDB_FORBIDDEN');
    const data = structuredClone(current.value.data);
    const verification=securityVerification(data);
    const ackField=operation==='policy'?'policy':operation==='emergency:off'?'emergencyStop':null;
    if(data.verification&&ackField&&!verification[ackField]&&acknowledgeRecovery!==data.recoveryId)denied('MDB_RECOVERY_ACK_REQUIRED');
    if (['level', 'on', 'off', 'messages', 'duplicate', 'mentions', 'links', 'cross-channel'].includes(operation)) {
      if(!verification.policy)denied('MDB_POLICY_UNCONFIRMED');
      data.policy = normalizeGuildSpamPolicy(applySpamProtectionCommand(data.policy, operation, value));
    } else if (operation === 'policy') {data.policy = normalizeGuildSpamPolicy(value);confirmRecoveryField(data,'policy');}
    else if (operation === 'auto:on' || operation === 'auto:off') {
      if(operation==='auto:on'&&(!verification.policy||!verification.emergencyStop||data.emergencyStop))denied('MDB_SAFETY_UNCONFIRMED');
      data.autoTimeout = operation === 'auto:on';confirmRecoveryField(data,'autoTimeout');
    }
    else if (operation === 'emergency:on' || operation === 'emergency:off') {data.emergencyStop = operation === 'emergency:on';confirmRecoveryField(data,'emergencyStop');}
    else if (operation === 'operator:add' || operation === 'operator:remove') {
      if (!id(value) || value === guildId) denied('MDB_INVALID_ROLE');
      data.operatorRoleIds = operation === 'operator:add' ? [...new Set([...data.operatorRoleIds, value])].sort()
        : data.operatorRoleIds.filter(v => v !== value);
      confirmRecoveryField(data,'operatorRoleIds');
    } else if (operation === 'log:set') { if (!id(value)) denied('MDB_INVALID_CHANNEL'); data.logChannelId = value;confirmRecoveryField(data,'logChannelId'); }
    else if (operation === 'log:off') {data.logChannelId = null;confirmRecoveryField(data,'logChannelId');}
    else denied('MDB_OPERATION_DENIED');
    validateSecurityData(data);
    return coordinator.update({ guildId, actorId, requestId, expectedRevision, expectedChecksum, action: operation, data });
  }
  async function automaticAllowed(guildId, { emergencyStop = true, expectedPolicy = null } = {}) {
    if (emergencyStop) return false;
    try {
      const { data } = (await read(guildId)).value;
      return automaticKnowledgeConfirmed(data) && data.autoTimeout === true && data.emergencyStop === false && data.policy.enabled === true &&
        (!expectedPolicy || checksum(expectedPolicy) === checksum(data.policy));
    } catch { return false; }
  }
  return Object.freeze({ read, change, automaticAllowed,
    async enrollUnconfirmed({guildId,actorId,requestId,recoveryId,verifyFence}) {
      if(typeof verifyFence!=='function'||await verifyFence()!==true)denied('MDB_FENCE_NOT_VERIFIED');
      const data=unconfirmedSecurityState(recoveryId);validateSecurityData(data);
      return coordinator.update({guildId,actorId,requestId,expectedRevision:0,expectedChecksum:'GENESIS',action:'recovery:unconfirmed',data});
    },
    async claimAutomaticIncident(guildId, incidentId, options) {
      if(!/^timeout-[a-f0-9]{40}$/.test(incidentId??'')||!options?.expectedPolicy||!await automaticAllowed(guildId,options))return false;
      try {
        const state=await read(guildId),data=state.value.data;
        if(!automaticKnowledgeConfirmed(data)||!data.autoTimeout||data.emergencyStop||!data.policy.enabled||options?.emergencyStop!==false||
          (options?.expectedPolicy&&checksum(options.expectedPolicy)!==checksum(data.policy)))return false;
        await coordinator.scoped(`timeout:${incidentId}`).update({guildId,expectedRevision:0,expectedChecksum:'GENESIS',
          actorId:'automatic-security',action:'timeout:claim',requestId:randomUUID(),
          data:{incidentId,consentRevision:state.value.revision,consentChecksum:state.checksum}});
        // Claim arbitration may take several network rounds. Consent must still
        // match immediately after that wait, before the existing Discord call.
        const fresh=await read(guildId);
        return fresh.checksum===state.checksum && automaticKnowledgeConfirmed(fresh.value.data) && fresh.value.data.autoTimeout===true && fresh.value.data.emergencyStop===false;
      }catch{return false;}
    },
    // Only an offline, verified, legacy-fenced snapshot may enroll a Guild. This
    // is not exposed via HTTP/Discord; no implicit consent or missing-row seed.
    async importFenced({ guildId, actorId, requestId, snapshot, verifyFence }) {
      if (typeof verifyFence !== 'function' || await verifyFence() !== true) denied('MDB_FENCE_NOT_VERIFIED');
      validateSecurityData(snapshot);
      return coordinator.update({ guildId, actorId, requestId, expectedRevision: 0, expectedChecksum: 'GENESIS', action: 'import', data: snapshot });
    },
  });
}

export function initialSecuritySnapshot() {
  return { policy: structuredClone(DEFAULT_GUILD_SPAM_POLICY), autoTimeout: false,
    emergencyStop: false, migrationState: 'complete', operatorRoleIds: [], logChannelId: null };
}
