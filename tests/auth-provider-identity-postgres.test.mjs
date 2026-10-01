import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadAuthIdentityMigration } from '../scripts/auth-migrations/loader.mjs'
import { runAuthIdentityScenarios } from './helpers/auth-identity-scenarios.mjs'

const databaseUrl = process.env.TEST_AUTH_IDENTITY_DATABASE_URL

test('Auth identity migration and real Better Auth callbacks on isolated PostgreSQL', {
  skip: !databaseUrl, timeout: 180_000,
}, async (t) => {
  const parsed = new URL(databaseUrl)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Local isolated PostgreSQL only')
  assert.equal(parsed.pathname, '/nuviloview_auth_identity_test', 'Explicit disposable test database required')
  assert.equal(process.env.TEST_AUTH_IDENTITY_ISOLATED, '1', 'Synthetic-only opt-in required')
  const admin = new pg.Client({ connectionString: databaseUrl })
  await admin.connect()
  t.after(() => admin.end())
  assert.equal((await admin.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0,
    'Refuse an existing populated test database')
  const migration = await loadAuthIdentityMigration()
  const base = await readFile(new URL('../docs/sql/web-auth-supabase-v1.sql', import.meta.url), 'utf8')
  const pools = []
  t.after(async () => { for (const pool of pools) await pool.end() })
  async function fixture(label) {
    const name = 'nuviloview_auth_identity_' + label + '_' + process.pid
    await admin.query('CREATE DATABASE "' + name + '"')
    const url = new URL(databaseUrl); url.pathname = '/' + name
    const pool = new pg.Pool({ connectionString: url.href, max: 20 })
    pools.push(pool)
    await pool.query(base)
    return { pool, connectionString: url.href }
  }
  async function seed(pool, duplicate = false) {
    await pool.query(`INSERT INTO public."user" (id,name,email) VALUES
      ('fixture-a','Synthetic A','fixture-a@users.invalid'),
      ('fixture-b','Synthetic B','fixture-b@users.invalid')`)
    await pool.query(`INSERT INTO public.account (id,"providerId","accountId","userId")
      VALUES ('fixture-a','google','same-subject','fixture-a'),
             ('fixture-b','google',$1,'fixture-b')`, [duplicate ? 'same-subject' : 'other-subject'])
  }
  await t.test('fresh empty Auth DB and migration rerun succeed', async () => {
    const { pool } = await fixture('empty')
    await pool.query(migration.sql)
    await pool.query(migration.sql)
  })
  await t.test('existing duplicate DB fails atomically without deleting either owner', async () => {
    const { pool } = await fixture('duplicate')
    await seed(pool, true)
    const client = await pool.connect()
    try {
      await assert.rejects(client.query(migration.sql), e => e.code === 'P0001')
      await client.query('ROLLBACK')
      assert.equal((await client.query('SELECT count(*)::int n FROM public.account')).rows[0].n, 2)
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='account_provider_identity_unique'")).rows[0].n, 0)
    } finally { client.release() }
  })
  await t.test('nullable identity schema is rejected instead of silently permitting a bypass', async () => {
    const { pool } = await fixture('nullable')
    await pool.query('ALTER TABLE public.account ALTER COLUMN "accountId" DROP NOT NULL')
    const client = await pool.connect()
    try {
      await assert.rejects(client.query(migration.sql), e => e.code === 'P0001')
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
  await t.test('wrong same-name user-scoped constraint is rejected', async () => {
    const { pool } = await fixture('wrongkey')
    await pool.query('ALTER TABLE public.account ADD CONSTRAINT account_provider_identity_unique UNIQUE ("providerId","accountId","userId")')
    const client = await pool.connect()
    try {
      await assert.rejects(client.query(migration.sql), e => e.code === 'P0001')
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
  const valid = await fixture('valid')
  await t.test('Auth migration CLI defaults to read-only and requires an exact target confirmation', async () => {
    const invoke = promisify(execFile)
    const args = [fileURLToPath(new URL('../scripts/migrate-auth-identity.mjs', import.meta.url))]
    const options = { windowsHide: true, env: { ...process.env, AUTH_MIGRATION_DATABASE_URL: valid.connectionString } }
    const plan = await invoke(process.execPath, args, options)
    const state = JSON.parse(plan.stdout.trim())
    assert.equal(state.mode, 'read-only')
    assert.equal(state.duplicate_groups, 0)
    assert.equal((await valid.pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='account_provider_identity_unique'")).rows[0].n, 0)
    await assert.rejects(invoke(process.execPath, [...args, '--execute', '--approve=' + migration.id, '--expect-fingerprint=wrong'], options))
    const apply = await invoke(process.execPath, [...args, '--execute', '--approve=' + migration.id, '--expect-fingerprint=' + state.fingerprint], options)
    assert.match(apply.stdout, /ownership uniqueness verified/)
  })
  await t.test('existing valid DB migrates without changing account rows', async () => {
    await seed(valid.pool)
    await valid.pool.query(migration.sql)
    await valid.pool.query(migration.sql)
    assert.equal((await valid.pool.query('SELECT count(*)::int n FROM public.account')).rows[0].n, 2)
    await assert.rejects(valid.pool.query(`INSERT INTO account(id,"providerId","accountId","userId")
      VALUES('null-fixture','google',NULL,'fixture-a')`), e => e.code === '23502')
    // Provider subjects are not globally unique across different providers.
    await valid.pool.query(`INSERT INTO account(id,"providerId","accountId","userId")
      VALUES('other-provider','discord','same-subject','fixture-b'),
            ('credential-a','credential','fixture-a','fixture-a'),
            ('credential-b','credential','fixture-b','fixture-b')`)
  })
  // The callback scenarios include a legacy Google-only user. Seed that
  // already-linked identity explicitly: a new Google identity must remain
  // blocked by Discord-first onboarding and cannot be used to create this row.
  await valid.pool.query(`INSERT INTO public."user" (id,name,email)
    VALUES ('scenario-google-only','Synthetic Google-only','google-google-a@users.invalid')`)
  await valid.pool.query(`INSERT INTO public.account (id,"providerId","accountId","userId")
    VALUES ('scenario-google-only-account','google','google-a','scenario-google-only')`)
  const outcomes = []
  await runAuthIdentityScenarios({
    ...valid,
    stress: process.env.AUTH_IDENTITY_STRESS === '1',
    record: (name, pass, details) => outcomes.push({ name, pass, ...details }),
  })
  for (const outcome of outcomes) await t.test(outcome.name, () => {
    t.diagnostic(JSON.stringify(outcome))
    assert.equal(outcome.pass, true)
  })
  await t.test('final aggregate duplicate groups are zero', async () => {
    const sql = await readFile(new URL('../scripts/auth-migrations/duplicate-audit.sql', import.meta.url), 'utf8')
    assert.equal((await valid.pool.query(sql)).rows[0].duplicate_groups, 0)
  })
})
