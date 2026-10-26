import { denied } from './coordinator.mjs';

// This schema must be installed in an isolated/coordinator namespace through an
// explicitly approved operation. Runtime never creates tables or membership.
export const ACCEPTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS mdb_membership (singleton INTEGER PRIMARY KEY CHECK(singleton=1), membership TEXT NOT NULL, provider_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mdb_acceptor (
 guild_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK(slot>0), promised TEXT NOT NULL,
 accepted_ballot TEXT, value TEXT, checksum TEXT,
 PRIMARY KEY(guild_id,slot),
 CHECK ((accepted_ballot IS NULL AND value IS NULL AND checksum IS NULL) OR
        (accepted_ballot IS NOT NULL AND value IS NOT NULL AND checksum IS NOT NULL))
);`;

// Each promise/accept is a single transactional SQL CAS. A promise is durable
// before being returned. SQL parameters never contain identifiers/DDL fragments.
export function createSqlAcceptor({ id, dialect, execute, namespace = '' }) {
  if (!['neon', 'supabase', 'turso'].includes(id) || !['postgres', 'sqlite'].includes(dialect)) denied('MDB_ADAPTER_CONFIG');
  const pg = dialect === 'postgres';
  const p = i => pg ? `$${i}` : `?${i}`;
  const collate = pg ? ' COLLATE "C"' : ' COLLATE BINARY';
  const rows = result => Array.isArray(result) ? result : result?.rows ?? [];
  const query = async (sql, args) => rows(await execute(sql, args));
  if (namespace && !/^[a-z0-9:-]{1,160}$/.test(namespace)) denied('MDB_NAMESPACE');
  const prefix = namespace ? `@${namespace}:` : '';
  const key = guild => prefix + guild;
  async function check(membership) {
    const row = (await query('SELECT membership,provider_id FROM mdb_membership WHERE singleton=1', []))[0];
    if (row?.membership !== membership || row.provider_id !== id) denied('MDB_MEMBERSHIP_MISMATCH');
  }
  const decode = row => row ? { promised: row.promised, acceptedBallot: row.accepted_ballot,
    value: row.value === null ? null : JSON.parse(row.value), checksum: row.checksum } : null;
  return Object.freeze({ id,
    withNamespace: scope => createSqlAcceptor({ id, dialect, execute, namespace: scope }),
    async resources(membership) {
      await check(membership);
      const keys=(await query('SELECT DISTINCT guild_id FROM mdb_acceptor WHERE accepted_ballot IS NOT NULL ORDER BY guild_id LIMIT 100001',[])).map(r=>r.guild_id);
      if(keys.length>100000)denied('MDB_RESOURCE_LIMIT');return keys;
    },
    async initializeMembership(membership) {
      // Management only: the Bot/Web runtime never invokes this method.
      const r=(await query(`INSERT INTO mdb_membership(singleton,membership,provider_id) VALUES(1,${p(1)},${p(2)})
       ON CONFLICT(singleton) DO UPDATE SET membership=mdb_membership.membership
       WHERE mdb_membership.membership=excluded.membership AND mdb_membership.provider_id=excluded.provider_id
       RETURNING membership,provider_id`,[membership,id]))[0];
      if(r?.membership!==membership||r.provider_id!==id)denied('MDB_MEMBERSHIP_MISMATCH');
    },
    async listGuilds(membership) {
      await check(membership);
      return (await query(`SELECT DISTINCT guild_id FROM mdb_acceptor WHERE accepted_ballot IS NOT NULL
        AND guild_id ${prefix ? 'LIKE' : 'NOT LIKE'} ${p(1)} ORDER BY guild_id LIMIT 10001`, [prefix ? prefix + '%' : '@%']))
        .map(r => r.guild_id.slice(prefix.length)).filter(g => /^\d{16,22}$/.test(g));
    },
    async load(membership, guildId, afterSlot = 0) {
      await check(membership);
      return (await query(`SELECT slot,promised,accepted_ballot,checksum FROM mdb_acceptor WHERE guild_id=${p(1)} AND slot>${p(2)}`, [key(guildId),afterSlot]));
    },
    async prepare(membership, guildId, slot, ballot) {
      await check(membership);
      return decode((await query(`INSERT INTO mdb_acceptor(guild_id,slot,promised)
        VALUES(${p(1)},${p(2)},${p(3)}) ON CONFLICT(guild_id,slot) DO UPDATE SET promised=excluded.promised
        WHERE mdb_acceptor.promised${collate} < excluded.promised${collate}
        RETURNING promised,accepted_ballot,value,checksum`, [key(guildId), slot, ballot]))[0]);
    },
    async accept(membership, guildId, slot, ballot, value, hash) {
      await check(membership);
      const result = await query(`UPDATE mdb_acceptor SET accepted_ballot=${p(3)},value=${p(4)},checksum=${p(5)}
        WHERE guild_id=${p(1)} AND slot=${p(2)} AND promised=${p(3)}
        AND (accepted_ballot IS NULL OR accepted_ballot<>${p(3)} OR checksum=${p(5)}) RETURNING slot`,
      [key(guildId), slot, ballot, JSON.stringify(value), hash]);
      return result.length === 1;
    },
  });
}
