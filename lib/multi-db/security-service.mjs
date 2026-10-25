import { DEFAULT_GUILD_SPAM_POLICY, normalizeGuildSpamPolicy, applySpamProtectionCommand } from '../guild-spam-policy.mjs';
import { denied, checksum } from './coordinator.mjs';

const id = v => typeof v === 'string' && /^\d{16,22}$/.test(v);
// One Guild aggregate serializes policy, explicit consent, operator delegation,
// emergency stop and log destination. They remain distinct data/authorization.
export function validateSecurityData(data) {
  if (!data || Object.keys(data).sort().join(',') !== 'autoTimeout,emergencyStop,logChannelId,migrationState,operatorRoleIds,policy' ||
      !normalizeGuildSpamPolicy(data.policy) || data.migrationState !== 'complete' ||
      typeof data.autoTimeout !== 'boolean' || typeof data.emergencyStop !== 'boolean' ||
      !Array.isArray(data.operatorRoleIds) || data.operatorRoleIds.length > 20 ||
      data.operatorRoleIds.some(v => !id(v)) ||
      (data.logChannelId !== null && !id(data.logChannelId))) denied('MDB_INVALID_SECURITY_STATE');
  return data;
}

export function createSecurityService(coordinator) {
  async function read(guildId) {
    const state = await coordinator.read(guildId);
    validateSecurityData(state.value.data);
    return state;
  }
  async function change({ guildId, actorId, requestId, expectedRevision, expectedChecksum, operation, value, authorize }) {
    // Caller supplies a fresh Discord/session authorization closure. No caller-
    // provided permissions, replica role caches or role names are trusted here.
    const current = await read(guildId);
    if (current.value.revision !== expectedRevision || current.checksum !== expectedChecksum) denied('MDB_REVISION_CONFLICT');
    if (typeof authorize !== 'function' || await authorize(operation) !== true) denied('MDB_FORBIDDEN');
    const data = structuredClone(current.value.data);
    if (['level', 'on', 'off', 'messages', 'duplicate', 'mentions', 'links', 'cross-channel'].includes(operation)) {
      data.policy = normalizeGuildSpamPolicy(applySpamProtectionCommand(data.policy, operation, value));
    } else if (operation === 'policy') data.policy = normalizeGuildSpamPolicy(value);
    else if (operation === 'auto:on' || operation === 'auto:off') data.autoTimeout = operation === 'auto:on';
    else if (operation === 'emergency:on' || operation === 'emergency:off') data.emergencyStop = operation === 'emergency:on';
    else if (operation === 'operator:add' || operation === 'operator:remove') {
      if (!id(value) || value === guildId) denied('MDB_INVALID_ROLE');
      data.operatorRoleIds = operation === 'operator:add' ? [...new Set([...data.operatorRoleIds, value])].sort()
        : data.operatorRoleIds.filter(v => v !== value);
    } else if (operation === 'log:set') { if (!id(value)) denied('MDB_INVALID_CHANNEL'); data.logChannelId = value; }
    else if (operation === 'log:off') data.logChannelId = null;
    else denied('MDB_OPERATION_DENIED');
    validateSecurityData(data);
    return coordinator.update({ guildId, actorId, requestId, expectedRevision, expectedChecksum, action: operation, data });
  }
  async function automaticAllowed(guildId, { emergencyStop = true, expectedPolicy = null } = {}) {
    if (emergencyStop) return false;
    try {
      const { data } = (await read(guildId)).value;
      return data.autoTimeout === true && data.emergencyStop === false && data.policy.enabled === true &&
        (!expectedPolicy || checksum(expectedPolicy) === checksum(data.policy));
    } catch { return false; }
  }
  return Object.freeze({ read, change, automaticAllowed,
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
