import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { getAuthCallbackPath, sanitizeAuthCallbackPath } from '../lib/auth-redirect.ts'
import { isAuthorizedGuild } from '../lib/community-analytics-utils.mjs'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('OAuth callback paths remain same-site and provider defaults are stable', () => {
  assert.equal(getAuthCallbackPath('google', '/'), '/account')
  assert.equal(getAuthCallbackPath('google', '/?landing=1'), '/account')
  assert.equal(getAuthCallbackPath('discord', '/'), '/dashboard')
  assert.equal(getAuthCallbackPath('google', '/privacy?from=login#policy'), '/privacy?from=login#policy')
  assert.equal(getAuthCallbackPath('discord', '/settings'), '/settings')

  for (const unsafe of [
    'https://evil.example/path',
    '//evil.example/path',
    '/\\evil.example/path',
    '/%2f%2fevil.example/path',
    '/%252f%252fevil.example/path',
    '/%5cevil.example/path',
    '/%0d%0aLocation:%20https://evil.example',
    '/api/auth/callback/google',
    '/auth-error',
  ]) {
    assert.equal(sanitizeAuthCallbackPath(unsafe, '/account'), '/account', unsafe)
  }
})

test('Better Auth owns OAuth state, PKCE and cross-user provider collision rejection', async () => {
  const [oauthState, genericState, callback, signIn] = await Promise.all([
    source('node_modules/better-auth/dist/oauth2/state.mjs'),
    source('node_modules/better-auth/dist/state.mjs'),
    source('node_modules/better-auth/dist/api/routes/callback.mjs'),
    source('node_modules/better-auth/dist/api/routes/sign-in.mjs'),
  ])

  assert.match(oauthState, /const codeVerifier = generateRandomString\(128\)/)
  assert.match(signIn, /codeVerifier,/)
  assert.match(genericState, /state_security_mismatch/)
  assert.match(genericState, /parsedData\.oauthState !== state/)
  assert.match(callback, /findAccountByProviderId\(providerAccountId, provider\.id\)/)
  assert.match(callback, /account_already_linked_to_different_user/)
})

test('Google identity remains separate from Discord Guild authorization', async () => {
  const [auth, discord, account, login] = await Promise.all([
    source('lib/auth.ts'),
    source('lib/discord.ts'),
    source('components/account-connections.tsx'),
    source('components/login-button.tsx'),
  ])

  assert.match(auth, /disableImplicitLinking:\s*true/)
  assert.match(auth, /scope:\s*\["openid", "email", "profile"\]/)
  assert.doesNotMatch(auth, /scope:\s*\[[^\]]*(drive|gmail|calendar|contacts)/i)
  assert.match(discord, /getDiscordAccount\(userId\)/)
  assert.match(discord, /if \(!linkedAccount\?\.accessToken\) return \[\]/)
  assert.equal(isAuthorizedGuild([], '123456789012345678'), false)
  assert.match(account, /authClient\.linkSocial\(/)
  assert.match(account, /Googleを連携してもDiscordサーバーへの権限は付与されません/)
  assert.match(login, /getAuthCallbackPath/)
})

test('Guild data routes preserve session and Discord-managed Guild boundaries', async () => {
  const routes = [
    'app/api/guilds/route.ts',
    'app/api/settings/theme/route.ts',
    'app/api/goals/route.ts',
    'app/api/messages/search/route.ts',
    'app/api/analytics/snapshot/route.ts',
    'app/api/analytics/community/route.ts',
    'app/api/analytics/runtime/route.ts',
    'app/api/history-import/route.ts',
  ]

  for (const route of routes) {
    const contents = await source(route)
    assert.match(contents, /auth\.api\.getSession/, `${route} must require a server session`)
    assert.match(contents, /getManagedGuilds/, `${route} must use the Discord-managed Guild list`)
  }
})

test('account UI and provider status never expose OAuth credentials', async () => {
  const [connections, status, privacy, terms, pro, settings] = await Promise.all([
    source('components/account-connections.tsx'),
    source('app/api/auth-provider-status/route.ts'),
    source('app/privacy/page.tsx'),
    source('app/terms/page.tsx'),
    source('app/pro/page.tsx'),
    source('app/settings/page.tsx'),
  ])

  assert.doesNotMatch(connections, /accessToken|refreshToken|idToken|clientSecret/)
  assert.doesNotMatch(status, /clientSecret|clientId|process\.env/)
  assert.match(privacy, /Googleアカウントの識別子、メールアドレス、表示名・アイコン/)
  assert.match(privacy, /Gmail、Google Drive、カレンダー、連絡先等への権限は要求しません/)
  assert.match(terms, /GoogleログインだけではDiscordサーバー情報へアクセスできず/)
  assert.match(pro, /Billingなし/)
  assert.doesNotMatch(pro, /checkoutSession|paymentIntent|subscriptionId|priceId/)
  assert.match(settings, /signOut\(\)/)
})
