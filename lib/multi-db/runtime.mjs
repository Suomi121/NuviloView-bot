import { Pool } from 'pg';
import { createCoordinator,checksum,denied } from './coordinator.mjs';
import { createSqlAcceptor } from './acceptor.mjs';
import { createSecurityService } from './security-service.mjs';
import { createPostgresPoolConfig } from '../sync/providers/registry.mjs';
import { createQuorumJournal } from './journal.mjs';
import { createDataPlane, createShardStore } from './data-plane.mjs';
import { quarantineVoter } from './rejoin.mjs';
import {recoveryPrefix,recoverySchema} from './recovery-bootstrap.mjs';
import {createGuildAccess} from './guild-access.mjs';

function postgresIdentity(value) {
  if (!value) return null;
  let url;try{url=new URL(value);}catch{throw new Error('MDB_DATABASE_IDENTITY');}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('MDB_DATABASE_IDENTITY');
  // Supabase pooler host is shared across projects; its user suffix is the ref.
  const ref = url.hostname.endsWith('.pooler.supabase.com') ? decodeURIComponent(url.username).split('.').at(-1) : /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  // Direct, session-pooler and transaction-pooler URLs can identify the SAME
  // project database despite different hosts, ports or DB roles.
  if(ref)return `supabase:${ref}:${url.pathname}`;
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

// Opt-in only after reviewed migration/fencing/import. No secret/env pulls,
// initialization DDL, enrollment or database switch is done at runtime.
export async function createSecurityCoordinatorRuntime(env = process.env, { storage = null, management = false } = {}) {
  if (env.SECURITY_COORDINATOR_MODE !== 'quorum') return null;
  if (env.SPAM_POLICY_AUTHORITY === 'sqlite') throw new Error('MDB_AUTHORITY_MODE_CONFLICT');
  const tablePrefix=env.SECURITY_COORDINATOR_TABLE_PREFIX??'';
  if(tablePrefix&&tablePrefix!==recoveryPrefix(env.SECURITY_COORDINATOR_EPOCH))throw new Error('MDB_RECOVERY_NAMESPACE');
  const supabase = postgresIdentity(env.SECURITY_COORDINATOR_SUPABASE_URL);
  if (supabase && [env.DATABASE_URL, env.WEB_AUTH_SUPABASE_DATABASE_URL].some(value => value && postgresIdentity(value) === supabase)) throw new Error('MDB_DATABASE_SEPARATION_REQUIRED');
  const resources = [], stores = [],setup=[];
  try {
  const providers = ['neon', 'supabase'].map(id => {
    const url = env[id === 'neon' ? 'DATABASE_URL' : 'SECURITY_COORDINATOR_SUPABASE_URL'];
    if (!url) throw new Error('MDB_CREDENTIALS_MISSING');
    // A dedicated Bot/Web Supabase database MUST NOT be the Auth database.
    if (id === 'supabase' && url === env.WEB_AUTH_SUPABASE_DATABASE_URL) throw new Error('MDB_AUTH_DATABASE_FORBIDDEN');
    const pool = new Pool(createPostgresPoolConfig(url, { queryTimeoutMs: 2000 }, 'nuviloview-security-quorum',
      id === 'supabase' ? env.SUPABASE_CA_CERT || null : null));
    resources.push(() => pool.end());
    if(id==='supabase')setup.push(()=>pool.query(recoverySchema(env.SECURITY_COORDINATOR_EPOCH)));
    stores.push(createShardStore({ id, dialect:'postgres', execute:(sql,args)=>pool.query(sql,args),tablePrefix }));
    return createSqlAcceptor({ id, dialect: 'postgres', execute: (sql, args) => pool.query(sql, args),tablePrefix });
  });
  const { createClient } = await import('@tursodatabase/serverless/compat');
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('MDB_CREDENTIALS_MISSING');
  const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  resources.push(() => client.close());
  setup.push(()=>client.executeMultiple(recoverySchema(env.SECURITY_COORDINATOR_EPOCH)));
  stores.push(createShardStore({ id:'turso', dialect:'sqlite', execute:(sql,args)=>client.execute({sql,args}),tablePrefix }));
  providers.push(createSqlAcceptor({ id: 'turso', dialect: 'sqlite', execute: (sql, args) => client.execute({ sql, args }),tablePrefix }));
  const quarantine=new Set((env.SECURITY_COORDINATOR_QUARANTINED_PROVIDERS??'').split(',').filter(Boolean));
  if(tablePrefix&&env.SECURITY_COORDINATOR_RECOVERY_NEON_REJOIN_APPROVED!==env.SECURITY_COORDINATOR_EPOCH)quarantine.add('neon');
  if([...quarantine].some(id=>!['neon','supabase','turso'].includes(id)))throw new Error('MDB_QUARANTINE_CONFIGURATION');
  const baseCoordinator = createCoordinator({ providers:providers.map(p=>quarantineVoter(p,quarantine)), epoch: env.SECURITY_COORDINATOR_EPOCH, checkpointing:true,
    journal: storage ? createQuorumJournal(storage) : null });
  let coordinator=baseCoordinator;
  if(tablePrefix&&!management){
    if(!/^\d{16,22}$/.test(env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID??'')||!/^[a-f0-9]{64}$/.test(env.SECURITY_COORDINATOR_RECOVERY_PLAN_CHECKSUM??''))throw new Error('MDB_RECOVERY_CONFIGURATION');
    const manifest=(await baseCoordinator.scoped('recovery').read(env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID)).value.data;
    if(manifest.planChecksum!==env.SECURITY_COORDINATOR_RECOVERY_PLAN_CHECKSUM||manifest.sourceState!=='unconfirmed')throw new Error('MDB_RECOVERY_CERTIFICATE');
    coordinator=Object.freeze({...baseCoordinator,recovery:{planChecksum:manifest.planChecksum,sourceState:'unconfirmed'}});
  }
  return Object.freeze({ coordinator, managementProviders:providers,
    async installReviewedRecoverySchema(approvedChecksum){
      if(!management||!tablePrefix||approvedChecksum!==checksum(recoverySchema(env.SECURITY_COORDINATOR_EPOCH)))denied('MDB_RECOVERY_SCHEMA_APPROVAL');
      for(const install of setup)await install();
    },dataPlane:createDataPlane({coordinator,stores}), security: createSecurityService(coordinator,
      env.APPLICATION_DATA_MODE==='quorum'?{allowGuild:guildId=>createGuildAccess({coordinator}).allowed(guildId)}:{}),
    close: () => Promise.all(resources.map(fn => fn())) });
  }catch(error){
    await Promise.allSettled(resources.map(fn=>Promise.resolve().then(fn)));
    throw new Error(/^MDB_[A-Z_]+$/.test(error?.message??'')?error.message:'MDB_PROVIDER_CONFIGURATION');
  }
}
