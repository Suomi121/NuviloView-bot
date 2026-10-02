import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../components/security-navigation-link.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports)

for (const en of [false, true]) {
  test(`security link renders accessible gradient navigation: en=${en}`, () => {
    const html = renderToStaticMarkup(React.createElement(mod.exports.SecurityNavigationLink, { en }))
    assert.match(html, /href="\/dashboard\/security\/spam"/)
    assert.ok(html.includes(en ? 'Security' : 'セキュリティー'))
    for (const style of ['bg-gradient-to-r', 'from-blue-700', 'to-violet-700', 'text-white', 'min-h-11', 'focus-visible:ring-2']) assert.ok(html.includes(style))
    assert.match(html, /aria-hidden="true"/)
  })
}

test('both desktop and mobile-accessible menus place Security immediately after Settings', async () => {
  const dashboard = await readFile(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8')
  assert.match(dashboard, /href="\/settings"\s*\/>\s*<SecurityNavigationLink en=\{en\} \/>/)
  assert.match(dashboard, /<span>\{en \? "Settings" : "設定"\}<\/span>\s*<\/a>\s*<SecurityNavigationLink en=\{en\} \/>/)
  assert.equal(dashboard.match(/<SecurityNavigationLink en=\{en\} \/>/g)?.length, 2)
})
