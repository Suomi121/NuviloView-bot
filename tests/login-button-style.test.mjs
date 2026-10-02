import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../components/login-button.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function render({ compact = false, locale = 'ja', signedIn = true, seconds = 0, pending = false } = {}) {
  const mod = { exports: {} }
  const scopedRequire = (id) => {
    if (id === '@/lib/auth-client') return { useSession: () => ({ data: signedIn ? { user: {} } : null }) }
    if (id === '@/components/locale-provider') return { useLocale: () => ({ locale }) }
    if (id === 'next/navigation') return { useRouter: () => ({}) }
    if (id === '@/lib/auth-redirect') return {}
    if (id === '@/lib/use-social-login') return { useSocialLogin: () => ({ pending, seconds }) }
    if (id === '@/components/discord-icon') return { DiscordIcon: () => null }
    if (id === '@/components/google-icon') return { GoogleIcon: () => null }
    return require(id)
  }
  new Function('require', 'module', 'exports', compiled)(scopedRequire, mod, mod.exports)
  return renderToStaticMarkup(React.createElement(mod.exports.LoginButton, { compact }))
}

for (const compact of [false, true]) {
  for (const locale of ['ja', 'en']) {
    test(`signed-in dashboard CTA retains primary background: compact=${compact}, locale=${locale}`, () => {
      const html = render({ compact, locale })
      assert.match(html, /href="\/dashboard"/)
      assert.match(html, /class="[^"]*\bbg-primary\b/)
      assert.match(html, /class="[^"]*\btext-primary-foreground\b/)
      assert.ok(html.includes(locale === 'ja' ? 'ダッシュボードを開く' : 'Open dashboard'))
    })
  }
}
test('signed-out Discord CTA still has primary background', () => {
  const html = render({ signedIn: false })
  assert.match(html, /Discordで続行/)
  assert.match(html, /class="[^"]*\bbg-primary\b/)
  assert.doesNotMatch(html, /ダッシュボードを開く/)
})

for (const compact of [false, true]) {
  for (const locale of ['ja', 'en']) {
    test(`rate limit guidance renders safely: compact=${compact}, locale=${locale}`, () => {
      const html = render({ compact, locale, signedIn: false, seconds: 12 })
      assert.match(html, /role="status"/)
      assert.ok(html.includes(locale === 'ja' ? 'あと12秒' : '12 seconds'))
      if (!compact) assert.match(html, /disabled=""/)
      assert.doesNotMatch(html, /データベース/)
    })
  }
}
test('shared pending state disables the landing login button', () => {
  assert.match(render({ signedIn: false, pending: true }), /disabled=""/)
})
