import { Pool } from 'pg';
import { createCoordinator } from './coordinator.mjs';
import { createSqlAcceptor } from './acceptor.mjs';
import { createSecurityService } from './security-service.mjs';
import { createPostgresPoolConfig } from '../sync/providers/registry.mjs';
import { createQuorumJournal } from './journal.mjs';

function postgresIdentity(value) {
  if (!value) return null;
  const url = new URL(value);
  // Supabase pooler host is shared across projects; its user suffix is the ref.
  const ref = url.hostname.endsWith('.pooler.supabase.com') ? decodeURIComponent(url.username).split('.').at(-1) : '';
  return `${url.hostname}:${url.port || '5432'}${url.pathname}:${ref}`;
}

// Opt-in only after reviewed migration/fencing/import. No secret/env pulls,
// initialization DDL, enrollment or database switch is done at runtime.
export async function createSecurityCoordinatorRuntime(env = process.env, { storage = null } = {}) {
  if (env.SECURITY_COORDINATOR_MODE !== 'quorum') return null;
  if (env.SPAM_POLICY_AUTHORITY === 'sqlite') throw new Error('MDB_AUTHORITY_MODE_CONFLICT');
  const supabase = postgresIdentity(env.SECURITY_COORDINATOR_SUPABASE_URL);
  if (supabase && [env.DATABASE_URL, env.WEB_AUTH_SUPABASE_DATABASE_URL].some(value => value && postgresIdentity(value) === supabase)) throw new Error('MDB_DATABASE_SEPARATION_REQUIRED');
  const resources = [];
  const providers = ['neon', 'supabase'].map(id => {
    const url = env[id === 'neon' ? 'DATABASE_URL' : 'SECURITY_COORDINATOR_SUPABASE_URL'];
    if (!url) throw new Error('MDB_CREDENTIALS_MISSING');
    // A dedicated Bot/Web Supabase database MUST NOT be the Auth database.
    if (id === 'supabase' && url === env.WEB_AUTH_SUPABASE_DATABASE_URL) throw new Error('MDB_AUTH_DATABASE_FORBIDDEN');
    const pool = new Pool(createPostgresPoolConfig(url, { queryTimeoutMs: 2000 }, 'nuviloview-security-quorum',
      id === 'supabase' ? env.SUPABASE_CA_CERT || null : null));
    resources.push(() => pool.end());
    return createSqlAcceptor({ id, dialect: 'postgres', execute: (sql, args) => pool.query(sql, args) });
  });
  const { createClient } = await import('@tursodatabase/serverless/compat');
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('MDB_CREDENTIALS_MISSING');
  const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  resources.push(() => client.close());
  providers.push(createSqlAcceptor({ id: 'turso', dialect: 'sqlite', execute: (sql, args) => client.execute({ sql, args }) }));
  const coordinator = createCoordinator({ providers, epoch: env.SECURITY_COORDINATOR_EPOCH,
    journal: storage ? createQuorumJournal(storage) : null });
  return Object.freeze({ coordinator, security: createSecurityService(coordinator), close: () => Promise.all(resources.map(fn => fn())) });
}
