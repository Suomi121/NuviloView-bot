// Bounded rotating repair; no LWW, automatic DLQ deletion or membership changes.
export function createQuorumReconciler({ coordinator, now = Date.now, intervalMs = 60000 }) {
  let lastAttempt = null, lastSuccess = null, cursor = 0, state = 'NOT_RUN';
  return Object.freeze({
    async processOnce() {
      if (lastAttempt !== null && now() - lastAttempt < intervalMs) return;
      lastAttempt = now();
      try {
        const guilds = await coordinator.listGuilds();
        if (guilds.length) await coordinator.read(guilds[cursor++ % guilds.length]);
        lastSuccess = now(); state = 'CONSISTENT';
      } catch (error) {
        state = ['MDB_CHECKSUM_CONFLICT', 'MDB_HISTORY_CONFLICT', 'MDB_SPLIT_BRAIN'].includes(error?.code)
          ? 'MANUAL_CONFLICT_REVIEW' : 'QUORUM_UNAVAILABLE';
      }
    },
    status: () => ({ state, lastAttempt, lastSuccess }),
  });
}
