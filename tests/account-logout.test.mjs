import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../components/account-logout.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText

// Execute the authored component without a browser/network. Rendering uses real
// React; handler tests supply deterministic hook state and a navigation spy.
function loadComponent({ react = React, locale = 'ja', signOut = async () => ({ error: null }), navigate = () => {} } = {}) {
  const compiledModule = { exports: {} }
  const scopedRequire = (id) => {
    if (id === 'react') return react
    if (id === '@/components/locale-provider') return { useLocale: () => ({ locale }) }
    if (id === '@/lib/auth-client') return { signOut }
    return require(id)
  }
  new Function('require', 'module', 'exports', 'window', compiled)(scopedRequire, compiledModule, compiledModule.exports, {
    location: { replace: navigate },
  })
  return compiledModule.exports.AccountLogout
}

function handlerHarness(signOut) {
  const cells = [], navigations = []
  let index = 0
  const react = {
    useRef(value) {
      const slot = index++
      return cells[slot] ??= { current: value }
    },
    useState(value) {
      const slot = index++
      if (!(slot in cells)) cells[slot] = value
      return [cells[slot], (next) => { cells[slot] = next }]
    },
  }
  const Component = loadComponent({ react, signOut, navigate: (url) => navigations.push(url) })
  const render = () => { index = 0; return Component() }
  const find = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return undefined
    if (predicate(tree)) return tree
    for (const child of React.Children.toArray(tree.props?.children)) {
      const result = find(child, predicate)
      if (result) return result
    }
  }
  return { render, navigations, button: () => find(render(), (node) => node.type === 'button'),
    alert: () => find(render(), (node) => node.props?.role === 'alert') }
}
const settled = () => new Promise((resolve) => setImmediate(resolve))

test('shared logout button renders Japanese and English with responsive accessible states', () => {
  for (const [locale, label] of [['ja', 'ログアウト'], ['en', 'Log out']]) {
    const Component = loadComponent({ locale })
    const html = renderToStaticMarkup(React.createElement(Component))
    assert.match(html, new RegExp(label))
    assert.match(html, /type="button"/)
    assert.match(html, /aria-busy="false"/)
    assert.match(html, /flex-col.*sm:flex-row/)
    assert.doesNotMatch(html, /role="alert"/)
  }
})

test('logout handler awaits Better Auth, prevents repeated submission, then replaces the document', async () => {
  let complete, calls = 0
  const ui = handlerHarness(() => { calls++; return new Promise((resolve) => { complete = resolve }) })
  const click = ui.button().props.onClick
  click(); click()
  assert.equal(calls, 1)
  assert.equal(ui.button().props.disabled, true)
  assert.deepEqual(ui.navigations, [])
  complete({ error: null })
  await settled()
  assert.deepEqual(ui.navigations, ['/?landing=1'])
  assert.equal(ui.alert(), undefined)
})

test('returned and thrown signOut failures do not navigate or expose internal details, and permit retry', async () => {
  for (const throws of [false, true]) {
    let fail = true
    const ui = handlerHarness(async () => {
      if (!fail) return { error: null }
      if (throws) throw new Error('fixture SQL stack token cookie session-private')
      return { error: { message: 'fixture SQL stack token cookie session-private' } }
    })
    ui.button().props.onClick()
    await settled()
    assert.deepEqual(ui.navigations, [])
    assert.equal(ui.button().props.disabled, false)
    const html = renderToStaticMarkup(ui.alert())
    assert.match(html, /ログアウトできませんでした/)
    assert.doesNotMatch(html, /SQL|stack|token|cookie|session-private/)
    fail = false
    ui.button().props.onClick()
    await settled()
    assert.deepEqual(ui.navigations, ['/?landing=1'])
  }
})

test('account and existing settings reuse one formal signOut flow and retain session guards', async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  const [account, settings, client, guilds, snapshot] = await Promise.all([
    read('app/account/page.tsx'), read('app/settings/page.tsx'), read('lib/auth-client.ts'),
    read('app/api/guilds/route.ts'), read('app/api/analytics/snapshot/route.ts'),
  ])
  assert.match(account, /<AccountLogout\s*\/>/)
  assert.match(settings, /session\?\.user && <AccountLogout\s*\/>/)
  assert.doesNotMatch(settings, /await signOut\(|const logOut\s*=/)
  assert.match(source, /import \{ signOut \} from '@\/lib\/auth-client'/)
  assert.match(source, /await signOut\(\)/)
  assert.match(client, /signOut.*= authClient/)
  assert.doesNotMatch(source, /document\.cookie|localStorage|sessionStorage|providerId|unlinkAccount/)
  assert.match(account, /if \(!session\?\.user\) redirect\('\/\?landing=1'\)/)
  assert.match(guilds, /!session\?\.user[\s\S]*status: 401/)
  assert.match(snapshot, /!session\?\.user[\s\S]*status: 401/)
})
