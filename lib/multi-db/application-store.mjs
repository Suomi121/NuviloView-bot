import { canonical, checksum, denied } from './coordinator.mjs';
import { registerApplicationArtifact } from './application-repair.mjs';

// Typed application records, NOT a SQL proxy. Auth credentials never enter this store.
export const APPLICATION_DOMAINS = Object.freeze({
  goals: { private: true, maxBytes: 8192 },
  'notification-receipts': { private: true, maxBytes: 65536 },
  alerts: { maxBytes: 262144 },
  'guild-settings': { maxBytes: 65536 },
  'channel-metadata': { maxBytes: 262144 },
  'reaction-roles': { maxBytes: 65536 },
  'guild-registry': { maxBytes: 8192 },
  analytics: { maxBytes: 16 * 1024 * 1024, publisher: true },
  runtime: { maxBytes: 262144, publisher: true },
  support: { private: true, control: true, maxBytes: 16384 },
});
const guild = id => { if (!/^\d{16,22}$/.test(id ?? '')) denied('APP_GUILD'); };
function binding({ epoch, domain, guildId, ownerId = '' }) {
  guild(guildId);
  const spec = APPLICATION_DOMAINS[domain];
  if (!spec || typeof ownerId !== 'string' || ownerId.length > 128 || (spec.private && !ownerId) || (!spec.private && ownerId)) denied('APP_DOMAIN');
  return { epoch, domain, guildId, ownerId };
}
export function applicationArtifact(input) { return checksum(binding(input)).slice(0, 32); }
function validate(domain, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) denied('APP_DATA');
  if (domain === 'goals') {
    if (!Array.isArray(data.goals) || data.goals.length > 3 || new Set(data.goals.map(g => g.type)).size !== data.goals.length || data.goals.some(g => !['member_growth','messages','voice_seconds'].includes(g.type) || !Number.isInteger(g.target) || g.target < 0 || g.target > 100000000)) denied('APP_GOALS');
  }
  if (domain === 'notification-receipts' && (!Array.isArray(data.dismissed) || data.dismissed.length > 500 || data.dismissed.some(id => !/^[a-f0-9]{32}$/.test(id)))) denied('APP_RECEIPTS');
  if (domain === 'alerts' && (!Array.isArray(data.alerts) || data.alerts.length > 200 || data.alerts.some(a => !/^[a-f0-9]{32}$/.test(a.id ?? '') || typeof a.title !== 'string' || a.title.length > 256 || typeof a.body !== 'string' || a.body.length > 2000 || !Number.isSafeInteger(a.createdAt)))) denied('APP_ALERTS');
  if (domain === 'reaction-roles' && (!Array.isArray(data.rules) || data.rules.length > 100 || data.rules.some(r =>
    !/^\d{16,22}$/.test(r.channelId ?? '') || !/^\d{16,22}$/.test(r.messageId ?? '') ||
    typeof r.emojiKey !== 'string' || r.emojiKey.length > 140 || typeof r.emojiDisplay !== 'string' || r.emojiDisplay.length > 128 ||
    !Array.isArray(r.roleIds) || r.roleIds.length < 1 || r.roleIds.length > 10 || new Set(r.roleIds).size !== r.roleIds.length ||
    r.roleIds.some(id => !/^\d{16,22}$/.test(id))))) denied('APP_REACTION_ROLES');
}

/** @param {{coordinator: any, dataPlane: any, authorize: Function, key?: Buffer | null, keyId?: string | null}} options */
export function createApplicationStore({ coordinator, dataPlane, authorize, key = null, keyId = null }) {
  if (!coordinator || !dataPlane || typeof authorize !== 'function') denied('APP_CONFIGURATION');
  const proofs = new Map();
  const reads = new Map();
  async function loadArtifact(guildId,artifactId) {
    if(reads.has(artifactId))return reads.get(artifactId);
    const pending=dataPlane.read({guildId,artifactId,key});reads.set(artifactId,pending);
    try{return await pending;}finally{if(reads.get(artifactId)===pending)reads.delete(artifactId);}
  }
  async function prove(b) {
    const isControl = b.domain === 'runtime' || APPLICATION_DOMAINS[b.domain].control;
    const id = `${isControl ? 'recovery' : 'guild'}:${b.guildId}`;
    if (proofs.has(id)) return proofs.get(id);
    const pending = (isControl ? coordinator.scoped('recovery') : coordinator).read(b.guildId);
    proofs.set(id,pending);
    try { return await pending; } finally { if (proofs.get(id) === pending) proofs.delete(id); }
  }
  async function access(input, operation) {
    const b = binding({ ...input, epoch: coordinator.epoch });
    if (await authorize({ ...b, operation, actorId: input.actorId }) !== true) denied('APP_FORBIDDEN');
    // An enrolled security record anchors the Guild in this epoch. No implicit enrollment.
    await prove(b);
    if (APPLICATION_DOMAINS[b.domain].private && (!Buffer.isBuffer(key) || key.length !== 32 || !keyId)) denied('APP_ENCRYPTION_REQUIRED');
    return b;
  }
  async function read(input) {
    const b = await access(input, 'read'), artifactId = applicationArtifact(b);
    try {
      const result = await loadArtifact(b.guildId, artifactId);
      const record = JSON.parse(result.bytes.toString('utf8'));
      if (canonical(record.binding) !== canonical(b) || record.version !== 1) denied('APP_BINDING_CONFLICT');
      validate(b.domain, record.data);
      return { state: 'confirmed', data: record.data, epoch: b.epoch, revision: result.chosen.value.revision, checksum: result.chosen.checksum, updatedAt: record.updatedAt, artifactId };
    } catch (error) {
      if (error.code !== 'MDB_NOT_ENROLLED') throw error;
      return { state: 'unconfirmed', data: null, epoch: b.epoch, revision: 0, checksum: 'GENESIS', updatedAt: null, artifactId };
    }
  }
  async function write(input) {
    const b = await access(input, 'write');
    if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(input.requestId ?? '') || !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.actorId ?? '')) denied('APP_INPUT');
    if (input.expectedEpoch !== b.epoch) denied('MDB_EPOCH_CONFLICT');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.expectedChecksum !== 'string') denied('APP_REVISION_REQUIRED');
    if (input.expectedRevision === 0 && input.acknowledgeUnconfirmed !== true) denied('APP_CONFIRMATION_REQUIRED');
    validate(b.domain, input.data);
    // Do not add a per-attempt clock/random value to a retried write intent.
    const record = { version: 1, binding: b, data: input.data, updatedAt: input.updatedAt ?? null };
    const bytes = Buffer.from(canonical(record));
    if (bytes.length > APPLICATION_DOMAINS[b.domain].maxBytes) denied('APP_CAPACITY');
    await registerApplicationArtifact({coordinator,guildId:b.guildId,artifactId:applicationArtifact(b),actorId:input.actorId});
    const chosen = await dataPlane.save({ guildId: b.guildId, artifactId: applicationArtifact(b), bytes,
      actorId: input.actorId, requestId: input.requestId, expectedRevision: input.expectedRevision, expectedChecksum: input.expectedChecksum,
      sensitive: Boolean(APPLICATION_DOMAINS[b.domain].private), key, keyId });
    return { state: 'confirmed', data: input.data, epoch: b.epoch, revision: chosen.value.revision, checksum: chosen.checksum, updatedAt: record.updatedAt };
  }
  return Object.freeze({ read, write,
    async repair(input) { const b = await access(input, 'repair'); return dataPlane.repair({ guildId: b.guildId, artifactId: applicationArtifact(b) }); },
    diagnostics: () => ({ ...coordinator.diagnostics(), domains: Object.keys(APPLICATION_DOMAINS), privateEncryption: Boolean(key), authority: 'quorum-manifest+2-of-3-shards', noLegacyFallback: true }),
  });
}
