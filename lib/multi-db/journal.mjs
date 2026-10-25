// Existing SQLite Audit + Outbox + provider deliveries are one local transaction.
// The quorum log can replay this projection after SQLite repair/replacement.
export function createQuorumJournal(storage, now = Date.now) {
  return chosen => storage.transaction(() => {
    const { value, checksum } = chosen;
    const eventId = `quorum:${value.epoch}:${value.guildId}:${value.revision}`;
    const old = storage.security.getByEventId(eventId);
    if (old) {
      if (old.payload.checksum !== checksum) throw new Error('MDB_JOURNAL_CONFLICT');
      return;
    }
    storage.security.appendAudit({ eventId, guildId: value.guildId, category: 'security_quorum',
      action: value.action, actorId: value.actorId, status: 'committed', occurredAt: now(), payload: { ...chosen, checksum } });
    storage.outbox.enqueue({ eventId, domain: 'security', eventType: 'security_quorum_v1',
      aggregateId: `quorum:${value.epoch}:${value.guildId}`, payload: chosen, schemaVersion: 1, priority: 10, createdAt: now() });
  });
}
