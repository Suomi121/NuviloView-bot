import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { guardedUnlink } from '../lib/auth-unlink-guard.ts'
import ts from 'typescript'
import { selectDisplayIdentity } from '../lib/display-identity.ts'

const require = createRequire(import.meta.url)
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
test('display identity prefers Discord, then Google, then user fallback', () => {
  const discord = { name: 'Discord name', image: 'discord-image' }, google = { name: 'Google name', image: 'google-image' }
  assert.deepEqual(selectDisplayIdentity({ discord, google }, {}), discord)
  assert.deepEqual(selectDisplayIdentity({ google }, {}), google)
  assert.deepEqual(selectDisplayIdentity({}, google), google)
  assert.deepEqual(selectDisplayIdentity({}, {}), { name: 'NuviloView user', image: null })
})
test('Google chooser uses the installed provider-supported option for login and link', async () => {
  const auth = await read('lib/auth.ts')
  assert.match(auth, /prompt: "select_account"/)
  const coreRequire = createRequire(require.resolve('better-auth'))
  const { google } = await import(pathToFileURL(coreRequire.resolve('@better-auth/core/social-providers')).href)
  const provider = google({ clientId: 'fixture', clientSecret: 'fixture', prompt: 'select_account' })
  const url = await provider.createAuthorizationURL({ state: 'fixture', codeVerifier: 'fixture', redirectURI: 'https://example.invalid/api/auth/callback/google' })
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.match(url.searchParams.get('scope'), /openid/)
})
test('avatar renders Google image, falls back after load failure, and retries a changed URL', async () => {
  const compiled = ts.transpileModule(await read('components/profile-avatar.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  let failed = null
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(id => id === 'react' ? { useState: () => [failed, next => { failed = next }] } : require(id), mod, mod.exports)
  const props = { image: 'https://lh3.googleusercontent.com/fixture', name: 'Google User' }
  let tree = mod.exports.ProfileAvatar(props)
  assert.equal(tree.type, 'img')
  tree.props.onError()
  tree = mod.exports.ProfileAvatar(props)
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.children, 'GO')
  assert.equal(mod.exports.ProfileAvatar({ ...props, image: 'https://lh3.googleusercontent.com/new' }).type, 'img')
})
test('provider cards expose hierarchy and use confirmed official unlink without raw errors', async () => {
  const source = await read('components/account-connections.tsx')
  assert.match(source, /メイン/); assert.match(source, /サブ/)
  assert.match(source, /authClient\.unlinkAccount/)
  assert.match(source, /最後のログイン方法は解除できません/)
  assert.match(source, /mutationInFlight\.current/)
  assert.match(source, /<dialog/)
  assert.doesNotMatch(source, /DELETE FROM|error\.message\}/)
})
test('Google image host is allowed without permitting arbitrary third-party images', async () => {
  const config = await read('next.config.mjs')
  assert.match(config, /https:\/\/lh3\.googleusercontent\.com/)
  assert.doesNotMatch(config, /img-src[^\n]*https:\s/)
})

test('unlink dialog requires confirmation, blocks double submission and refreshes after success', async () => {
  const compiled = ts.transpileModule(await read('components/account-connections.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const cells = [[{ id: 'a', providerId: 'discord' }, { id: 'b', providerId: 'google' }], false]
  let cursor = 0, calls = 0, refreshes = 0, resolveUnlink
  const navigations = []
  const mod = { exports: {} }
  const react = {
    useState(value) { const i = cursor++; if (!(i in cells)) cells[i] = value; return [cells[i], next => { cells[i] = next }] },
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value } },
    useEffect() {},
  }
  new Function('require', 'module', 'exports', 'window', compiled)(id => {
    if (id === 'react') return react
    if (id === '@/components/locale-provider') return { useLocale: () => ({ locale: 'ja' }) }
    if (id === '@/components/discord-icon') return { DiscordIcon: () => null }
    if (id === '@/components/google-icon') return { GoogleIcon: () => null }
    if (id === '@/lib/auth-client') return { authClient: {
      unlinkAccount() { calls++; return new Promise(resolve => { resolveUnlink = resolve }) },
      async listAccounts() { refreshes++; return { data: [{ id: 'b', providerId: 'google' }] } },
    } }
    return require(id)
  }, mod, mod.exports, { location: { replace: path => navigations.push(path) } })
  const render = () => { cursor = 0; return mod.exports.AccountConnections({ providerAvailability: { google: true, discord: true } }) }
  const find = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return
    if (predicate(tree)) return tree
    for (const child of React.Children.toArray(tree.props?.children)) { const result = find(child, predicate); if (result) return result }
  }
  find(render(), n => n.type === 'button' && n.props.children === '連携解除').props.onClick()
  assert.equal(calls, 0)
  assert.ok(find(render(), n => n.type === 'dialog'))
  assert.ok(find(render(), n => n.type === 'p' && String(n.props.children).includes('Googleでのログインは引き続き')))
  find(render(), n => n.type === 'button' && n.props.children === 'キャンセル').props.onClick()
  assert.equal(find(render(), n => n.type === 'dialog'), undefined)
  assert.equal(calls, 0)
  find(render(), n => n.type === 'button' && n.props.children === '連携解除').props.onClick()
  const confirm = find(render(), n => n.type === 'button' && n.props.children === '解除する')
  confirm.props.onClick(); confirm.props.onClick()
  assert.equal(calls, 1)
  assert.equal(find(render(), n => n.type === 'button' && n.props.children === '解除中…').props.disabled, true)
  resolveUnlink({ error: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refreshes, 1)
  assert.deepEqual(navigations, ['/account'])
  assert.equal(find(render(), n => n.type === 'button' && n.props.children === '連携解除').props.disabled, true)
})

test('server unlink guard rejects lock contention and last provider without deleting', async () => {
  for (const [locked, remaining] of [[false, 2], [true, 0]]) {
    let deleted = false, released = false
    const client = {
      async query(sql) {
        if (sql.startsWith('SELECT "userId"')) return { rows: [{ userId: 'fixture' }] }
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] }
        if (sql.includes('count(*)')) return { rows: [{ n: remaining }] }
        return { rows: [] }
      },
      release() { released = true },
    }
    await assert.rejects(guardedUnlink({ connect: async () => client }, 'fixture', async () => { deleted = true }))
    assert.equal(deleted, false)
    assert.equal(released, true)
  }
})
