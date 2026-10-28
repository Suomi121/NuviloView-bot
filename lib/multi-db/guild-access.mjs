import { denied } from './coordinator.mjs';

// Blocklist is security authority, never a last-known-good allow-list. Missing
// or unreachable policy denies execution without treating it as a true block
// (unknown must not cause destructive cleanup or an automatic Guild leave).
export function createGuildAccess({ coordinator }) {
  const scope = coordinator.scoped('guild-access');
  const pending = new Map();
  async function load(guildId) {
    await coordinator.read(guildId); // explicit epoch enrollment, not a ping
    try {
      const chosen = await scope.read(guildId), data = chosen.value.data;
      if (!['allow','block'].includes(data.decision) || !Array.isArray(data.audit)) denied('APP_GUILD_ACCESS_CORRUPT');
      return { state: 'confirmed', decision: data.decision, data, epoch: coordinator.epoch,
        revision: chosen.value.revision, checksum: chosen.checksum };
    } catch (error) {
      if (error.code !== 'MDB_NOT_ENROLLED') throw error;
      return { state: 'unconfirmed', decision: 'unknown', data: null, epoch: coordinator.epoch, revision: 0, checksum: 'GENESIS' };
    }
  }
  async function read(guildId) {
    // Join simultaneous observations only; no TTL/LKG permission cache.
    if (pending.has(guildId)) return pending.get(guildId);
    const operation = load(guildId); pending.set(guildId, operation);
    try { return await operation; } finally { if (pending.get(guildId) === operation) pending.delete(guildId); }
  }
  return Object.freeze({ read,
    async allowed(guildId) {
      try { return (await read(guildId)).decision === 'allow'; } catch { return false; }
    },
    async change({ guildId, decision, reason = '', actorId, requestId, expected, acknowledgeUnconfirmed = false, authorize, occurredAt }) {
      if (typeof authorize !== 'function' || await authorize() !== true) denied('APP_FORBIDDEN');
      if (!['allow','block'].includes(decision) || typeof reason !== 'string' || reason.length > 300 ||
          (decision === 'block' && reason.trim().length < 3) || !Number.isSafeInteger(occurredAt)) denied('APP_INPUT');
      const current = await read(guildId);
      if (expected?.epoch !== current.epoch || expected?.revision !== current.revision || expected?.checksum !== current.checksum) denied('MDB_REVISION_CONFLICT');
      if (current.state !== 'confirmed' && acknowledgeUnconfirmed !== true) denied('APP_CONFIRMATION_REQUIRED');
      if (await authorize() !== true) denied('APP_FORBIDDEN');
      const entry = { guildId, decision, reason, actorId, requestId, occurredAt };
      return scope.update({ guildId, expectedRevision: current.revision, expectedChecksum: current.checksum,
        actorId, requestId, action: `guild-access:${decision}`,
        data: { decision, reason, actorId, occurredAt, audit: [...(current.data?.audit ?? []), entry].slice(-100) } });
    },
    async list() {
      const rows = [];
      // Read every item from quorum, not the union's unverified old values.
      for (const guildId of await coordinator.listGuilds()) rows.push({ guildId, ...await read(guildId) });
      return rows;
    },
  });
}
