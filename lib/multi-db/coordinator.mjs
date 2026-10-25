import { createHash, randomBytes } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const checksum = value => createHash('sha256').update(canonical(value)).digest('hex');
export function denied(code) { throw Object.assign(new Error(code), { code }); }
const clone = value => JSON.parse(JSON.stringify(value));
const validGuild = value => typeof value === 'string' && /^\d{16,22}$/.test(value);

// Fixed-membership, crash-recovery Paxos log. SQLite is NOT a voting member.
// Every slot runs prepare + accept; no timestamp LWW, speculative reads or leases.
export function createCoordinator({ providers, epoch, writer = randomBytes(16).toString('hex'), timeoutMs = 2000, maxSlots = 1000, journal = null }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(epoch ?? '') || !/^[a-f0-9]{32}$/.test(writer) ||
      providers?.length !== 3 || new Set(providers.map(p => p.id)).size !== 3 ||
      providers.map(p => p.id).sort().join(',') !== 'neon,supabase,turso') denied('MDB_CONFIGURATION');
  const membership = canonical({ epoch, voters: providers.map(p => p.id).sort(), version: 1 });
  let counter = 0n;
  let journalState = journal ? 'UNKNOWN' : 'NOT_ATTACHED';
  const health = new Map(providers.map(p => [p.id, { read: 'UNKNOWN', write: 'UNKNOWN' }]));
  const bounded = async (fn) => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('MDB_TIMEOUT')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  async function each(method, ...args) {
    const reading = method === 'load' || method === 'listGuilds';
    return (await Promise.all(providers.map(async p => {
      try {
        const value = await bounded(() => p[method](membership, ...args));
        health.set(p.id, { read: 'AVAILABLE', write: reading ? health.get(p.id).write : 'AVAILABLE' });
        return { id: p.id, value };
      } catch {
        health.set(p.id, { read: reading ? 'UNAVAILABLE' : health.get(p.id).read,
          write: reading ? health.get(p.id).write : 'UNAVAILABLE' });
        return null; // never expose raw provider diagnostics, URLs or headers
      }
    }))).filter(Boolean);
  }
  function observe(ballot) {
    if (!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(ballot ?? '')) denied('MDB_CORRUPT_BALLOT');
    const n = BigInt(`0x${ballot.slice(0, 16)}`); if (n > counter) counter = n;
  }
  function ballot() {
    counter++;
    if (counter > 0xffffffffffffffffn) denied('MDB_BALLOT_EXHAUSTED');
    return `${counter.toString(16).padStart(16, '0')}:${writer}`;
  }
  function validate(value, guildId, slot, previous) {
    if (!value || value.epoch !== epoch || value.guildId !== guildId || value.revision !== slot ||
        value.previousChecksum !== previous || typeof value.requestId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.intentHash ?? '') || !value.data ||
        checksum(value.data).length !== 64) denied('MDB_HISTORY_CONFLICT');
  }
  async function prepare(guildId, slot) {
    const b = ballot();
    const votes = await each('prepare', guildId, slot, b);
    // A rejected prepare never counts towards the quorum.
    const granted = votes.filter(v => v.value?.promised === b);
    if (granted.length < 2) denied('MDB_NO_WRITE_QUORUM');
    const accepted = granted.map(v => v.value).filter(v => v.acceptedBallot);
    for (const v of accepted) {
      observe(v.acceptedBallot);
      if (checksum(v.value) !== v.checksum) denied('MDB_CHECKSUM_CONFLICT');
    }
    accepted.sort((a, b) => b.acceptedBallot.localeCompare(a.acceptedBallot));
    if (accepted.some(v => v.acceptedBallot === accepted[0]?.acceptedBallot && v.checksum !== accepted[0].checksum)) denied('MDB_SPLIT_BRAIN');
    return { ballot: b, adopted: accepted[0]?.value ?? null };
  }
  async function accept(guildId, slot, b, value) {
    const hash = checksum(value);
    const votes = await each('accept', guildId, slot, b, clone(value), hash);
    if (votes.filter(v => v.value === true).length < 2) denied('MDB_OUTCOME_UNKNOWN');
    const chosen = { value, checksum: hash, fencingToken: `${epoch}:${slot}:${b}` };
    if (journal) {
      try { await journal(clone(chosen)); journalState = 'DURABLE'; }
      catch { journalState = 'UNAVAILABLE'; } // cloud quorum already committed; never falsely report rollback
    }
    return chosen;
  }
  // Reads seal the first empty slot. Pending accepted values are adopted and
  // chosen before returning; a minority's stale value is never a read authority.
  async function recover(guildId) {
    if (!validGuild(guildId)) denied('MDB_INVALID_GUILD');
    const loaded = await each('load', guildId);
    if (loaded.length < 2) denied('MDB_NO_READ_QUORUM');
    for (const p of loaded) for (const row of p.value) observe(row.promised);
    const history = [];
    let previous = 'GENESIS';
    for (let slot = 1; slot <= maxSlots; slot++) {
      const prepared = await prepare(guildId, slot);
      if (!prepared.adopted) return { history, previous, slot, ballot: prepared.ballot };
      validate(prepared.adopted, guildId, slot, previous);
      const chosen = await accept(guildId, slot, prepared.ballot, prepared.adopted);
      history.push(chosen); previous = chosen.checksum;
    }
    denied('MDB_HISTORY_LIMIT'); // no unsafe truncation or checkpoint inference
  }
  async function read(guildId) {
    const recovered = await recover(guildId);
    const last = recovered.history.at(-1);
    if (!last) denied('MDB_NOT_ENROLLED');
    return clone(last);
  }
  async function update({ guildId, expectedRevision, expectedChecksum, requestId, actorId, action, data }) {
    if (!validGuild(guildId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !/^[a-zA-Z0-9:_-]{1,128}$/.test(requestId ?? '') ||
        !/^[a-zA-Z0-9:_-]{1,128}$/.test(actorId ?? '') ||
        !/^[a-zA-Z0-9:_-]{1,80}$/.test(action ?? '') || !data || canonical(data).length > 65536) denied('MDB_INVALID_WRITE');
    const intentHash = checksum({ guildId, actorId, action, data, expectedRevision, expectedChecksum });
    const recovered = await recover(guildId);
    const existing = recovered.history.find(v => v.value.requestId === requestId);
    if (existing) {
      if (existing.value.intentHash !== intentHash) denied('MDB_IDEMPOTENCY_CONFLICT');
      return clone(existing); // original outcome, NOT a later unrelated state
    }
    if (recovered.slot - 1 !== expectedRevision || recovered.previous !== expectedChecksum) denied('MDB_REVISION_CONFLICT');
    const value = { guildId, epoch, revision: recovered.slot, previousChecksum: recovered.previous,
      requestId, actorId, action, intentHash, data: clone(data) };
    validate(value, guildId, recovered.slot, recovered.previous);
    return accept(guildId, recovered.slot, recovered.ballot, value);
  }
  async function listGuilds() {
    const lists = await each('listGuilds');
    if (lists.length < 2) denied('MDB_NO_READ_QUORUM');
    const ids = [...new Set(lists.flatMap(v => v.value))].sort();
    if (ids.length > 10000 || ids.some(id => !validGuild(id))) denied('MDB_INVENTORY_INVALID');
    return ids;
  }
  async function inspect(guildId) {
    if (!validGuild(guildId)) denied('MDB_INVALID_GUILD');
    const loaded = await each('load', guildId);
    return { epoch, observedReadProviders: loaded.map(p => p.id), writeQuorumProven: false,
      // Observed accepted slots are NOT a chosen revision or promotion proof.
      accepted: Object.fromEntries(loaded.map(p => [p.id, {
        count: p.value.filter(r => r.accepted_ballot).length,
        maxSlot: Math.max(0, ...p.value.filter(r => r.accepted_ballot).map(r => Number(r.slot))),
      }])) };
  }
  return Object.freeze({ read, update, recover, listGuilds, inspect, epoch, membership,
    diagnostics: () => ({ epoch, quorum: '2/3', authority: 'cloud-quorum',
      providers: Object.fromEntries(health), journal: journalState, rollback: 'fenced-only', automaticMembershipChange: false }) });
}
