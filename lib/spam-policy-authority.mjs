import { createHash } from 'node:crypto';
import { serializeJson } from './storage/contracts.mjs';
import { normalizeGuildSpamPolicy, getSpamPolicyAuditChanges, applySpamProtectionCommand } from './guild-spam-policy.mjs';

const key = guildId => `spam-policy-authority:v1:${guildId}`;
const digest = value => createHash('sha256').update(serializeJson(value)).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function id(value) {
  if (typeof value !== 'string' || !/^\d{16,22}$/.test(value)) fail('SPAM_AUTHORITY_INVALID_ID');
  return value;
}

// These records are durable authority metadata, NEVER the last-known-policy cache.
// A single SQLite transaction includes the state, immutable audit and existing Outbox.
export function createSpamPolicyAuthority({ storage, writerId, enabled = false, now = Date.now } = {}) {
  if (enabled && (!storage?.enabled || !storage?.writeEnabled || !/^[a-zA-Z0-9_-]{1,80}$/.test(writerId ?? ''))) {
    fail('SPAM_AUTHORITY_CONFIGURATION_INVALID');
  }
  function read(guildId) {
    if (!enabled) return null;
    const record = storage.syncMetadata.get(key(id(guildId)));
    if (!record) fail('SPAM_AUTHORITY_NOT_IMPORTED');
    const state = record.metadata;
    if (record.state !== 'active' || state?.writerId !== writerId || !state.epoch ||
        !Number.isSafeInteger(state.revision) || state.revision < 1 ||
        !normalizeGuildSpamPolicy(state.policy) || state.checksum !== digest(state.policy)) fail('SPAM_AUTHORITY_INVALID');
    return state;
  }
  function commit(guildId, state, actorId, eventId, before, action) {
    storage.syncMetadata.set({ streamName: key(guildId), state: 'active', metadata: state });
    const payload = { guildId, writerId, epoch: state.epoch, revision: state.revision,
      policy: state.policy, checksum: state.checksum, changes: getSpamPolicyAuditChanges(before, state.policy),
      autoTimeout: false, actorId };
    const audit = storage.security.appendAudit({ eventId, guildId, category: 'spam_policy', action,
      actorId, status: 'committed', occurredAt: now(), payload });
    if (!audit.inserted) fail('SPAM_AUTHORITY_EVENT_COLLISION');
    storage.outbox.enqueue({ eventId, domain: 'security', eventType: 'spam_policy_authority_v1',
      aggregateId: `spam-policy:${guildId}:${state.epoch}`, payload, schemaVersion: 1, priority: 10,
      createdAt: audit.occurredAt });
    return state;
  }
  function importFencedSnapshot(snapshot) {
    if (!enabled) fail('SPAM_AUTHORITY_DISABLED');
    const guildId = id(snapshot?.guildId);
    const policy = normalizeGuildSpamPolicy(JSON.parse(JSON.stringify(snapshot.policy ?? null)));
    if (!policy || snapshot.writerId !== writerId || snapshot.autoTimeout !== false ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(snapshot.epoch ?? '') || snapshot.fenced !== true) fail('SPAM_AUTHORITY_IMPORT_INVALID');
    return storage.transaction(() => {
      const previous = storage.syncMetadata.get(key(guildId));
      if (previous) {
        const current = read(guildId);
        if (current.epoch !== snapshot.epoch || current.seedChecksum !== digest(policy)) fail('SPAM_AUTHORITY_IMPORT_CONFLICT');
        return current; // retry after a crash must never reset later local changes
      }
      const state = { writerId, epoch: snapshot.epoch, revision: 1, policy, checksum: digest(policy), seedChecksum: digest(policy) };
      return commit(guildId, state, 'authority-import', `spam-policy:${guildId}:${state.epoch}:1`, null, 'import');
    });
  }
  function update({ guildId, actorId, operation, value, requestId, expectedRevision }) {
    id(guildId); id(actorId); id(requestId);
    if (!enabled) fail('SPAM_AUTHORITY_DISABLED');
    const eventId = `spam-policy-command:${guildId}:${requestId}`;
    return storage.transaction(() => {
      const current = read(guildId);
      const requestHash = digest({ guildId, actorId, operation, value });
      const previous = storage.security.getByEventId(eventId);
      if (previous) {
        if (previous.payload.requestHash !== requestHash) fail('SPAM_AUTHORITY_REQUEST_COLLISION');
        return current;
      }
      if (current.revision !== expectedRevision) fail('SPAM_AUTHORITY_REVISION_CONFLICT');
      if (!['level', 'on', 'off', 'messages', 'duplicate', 'mentions', 'links', 'cross-channel'].includes(operation)) fail('SPAM_AUTHORITY_OPERATION_DENIED');
      const policy = normalizeGuildSpamPolicy(applySpamProtectionCommand(current.policy, operation, value));
      if (!policy || current.revision >= Number.MAX_SAFE_INTEGER) fail('SPAM_AUTHORITY_POLICY_INVALID');
      policy.updatedAt = new Date(now()).toISOString();
      policy.updatedBy = actorId;
      const state = { ...current, revision: current.revision + 1, policy, checksum: digest(policy) };
      // request hash in the same immutable event enables safe Interaction retries.
      storage.syncMetadata.set({ streamName: key(guildId), state: 'active', metadata: state });
      const payload = { guildId, writerId, epoch: state.epoch, revision: state.revision, policy,
        checksum: state.checksum, changes: getSpamPolicyAuditChanges(current.policy, policy), actorId, requestHash, autoTimeout: false };
      const audit = storage.security.appendAudit({ eventId, guildId, category: 'spam_policy', action: operation,
        actorId, status: 'committed', occurredAt: now(), payload });
      if (!audit.inserted) fail('SPAM_AUTHORITY_EVENT_COLLISION');
      storage.outbox.enqueue({ eventId, domain: 'security', eventType: 'spam_policy_authority_v1',
        aggregateId: `spam-policy:${guildId}:${state.epoch}`, payload, schemaVersion: 1, priority: 10, createdAt: audit.occurredAt });
      return state;
    });
  }
  return Object.freeze({ enabled, read, update, importFencedSnapshot });
}
