import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { providerLabel } from '../lib/provider-label.ts'

test('provider labels keep Google email and Discord username separate and omit secrets', () => {
  const info = { user: { name: 'Display', email: 'fixture@example.invalid', id: 'private-id' }, data: { username: 'discord-fixture', token: 'private-token' } }
  assert.deepEqual(providerLabel('google', info), { name: 'Display', detail: 'fixture@example.invalid' })
  assert.deepEqual(providerLabel('discord', info), { name: 'Display', detail: 'discord-fixture' })
  assert.deepEqual(providerLabel('google', null), { name: null, detail: null })
  assert.deepEqual(providerLabel('discord', { user: { name: 42 }, data: { username: ' ' } }), { name: null, detail: null })
})

async function route(api) {
  const source = await readFile(new URL('../app/api/account-connections/route.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', js)(id => {
    if (id === '@/lib/auth') return { auth: { api } }
    if (id === '@/lib/provider-label') return { providerLabel }
    if (id === 'next/server') return { NextResponse: { json: (body, options) => ({ body, ...options }) } }
    throw new Error('Unexpected dependency')
  }, mod, mod.exports)
  return mod.exports.GET
}

test('label route denies unauthenticated requests before reading accounts', async () => {
  const get = await route({ getSession: async () => null, listUserAccounts: async () => { throw new Error('Must not read') } })
  const result = await get(new Request('https://example.invalid/api/account-connections'))
  assert.equal(result.status, 401)
  assert.equal(result.headers['Cache-Control'], 'private, no-store')
})

test('label route selects only session accounts, ignores caller IDs and isolates provider failures', async () => {
  const queries = []
  const get = await route({
    getSession: async () => ({ user: { id: 'self' } }),
    listUserAccounts: async () => [{ providerId: 'google', accountId: 'own-google' }, { providerId: 'discord', accountId: 'own-discord' }],
    accountInfo: async ({ query }) => {
      queries.push(query)
      if (query.providerId === 'discord') throw new Error('private transport error')
      return { user: { name: 'Google name', email: 'fixture@example.invalid' }, data: { secret: 'not-for-client' } }
    },
  })
  const result = await get(new Request('https://example.invalid/api/account-connections?userId=other&accountId=other'))
  assert.deepEqual(queries, [{ providerId: 'discord', accountId: 'own-discord' }, { providerId: 'google', accountId: 'own-google' }])
  assert.deepEqual(result.body, { discord: null, google: { name: 'Google name', detail: 'fixture@example.invalid' } })
  assert.equal(result.headers['Cache-Control'], 'private, no-store')
})
