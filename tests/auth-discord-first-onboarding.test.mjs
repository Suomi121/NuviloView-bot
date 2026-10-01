import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { handleOAuthUserInfo } from '../node_modules/better-auth/dist/oauth2/link-account.mjs'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function oauthFixture({ existing = false, unlinked = false } = {}) {
  const calls = { users: 0, sessions: 0, updates: 0 }
  const user = { id: 'synthetic-user', name: 'Synthetic', email: 'synthetic@users.invalid', emailVerified: true }
  const account = { id: 'synthetic-account', providerId: 'google', accountId: 'synthetic-subject', userId: user.id }
  const ctx = { context: {
    options: { account: { accountLinking: { disableImplicitLinking: true } } },
    trustedProviders: [],
    internalAdapter: {
      findOAuthUser: async () => existing || unlinked
        ? { user, linkedAccount: unlinked ? null : account, accounts: unlinked ? [{ ...account, providerId: 'discord' }] : [account] }
        : null,
      createOAuthUser: async () => { calls.users++; return { user, account } },
      createSession: async () => { calls.sessions++; return { id: 'synthetic-session' } },
      updateAccount: async () => { calls.updates++ },
      updateUser: async () => { calls.updates++ },
    },
  } }
  const opts = {
    userInfo: { id: 'synthetic-subject', name: 'Synthetic', email: user.email, emailVerified: true },
    account: { providerId: 'google', accountId: 'synthetic-subject' },
    callbackURL: '/account',
    disableSignUp: true,
  }
  return { ctx, opts, calls }
}

test('unknown Google identity cannot create a Better Auth user or session', async () => {
  const auth = await source('lib/auth.ts')
  assert.match(auth, /google:\s*\{[\s\S]*?disableSignUp:\s*true/)
  const { ctx, opts, calls } = oauthFixture()
  const result = await handleOAuthUserInfo(ctx, opts)
  assert.equal(result.error, 'signup disabled')
  assert.deepEqual(calls, { users: 0, sessions: 0, updates: 0 })
})

test('linked Google identity and existing Google-only user can still sign in', async () => {
  const { ctx, opts, calls } = oauthFixture({ existing: true })
  const result = await handleOAuthUserInfo(ctx, opts)
  assert.equal(result.error, null)
  assert.equal(result.isRegister, false)
  assert.deepEqual(calls, { users: 0, sessions: 1, updates: 0 })
})

test('matching email without an explicit Google link never merges users', async () => {
  const { ctx, opts, calls } = oauthFixture({ unlinked: true })
  const result = await handleOAuthUserInfo(ctx, opts)
  assert.equal(result.error, 'account not linked')
  assert.deepEqual(calls, { users: 0, sessions: 0, updates: 0 })
})

test('Discord remains the new-user onboarding provider', async () => {
  const auth = await source('lib/auth.ts')
  const discordConfig = auth.slice(auth.indexOf('discord: {'), auth.indexOf('...(providerAvailability.google'))
  assert.doesNotMatch(discordConfig, /disableSignUp:\s*true/)
  assert.match(discordConfig, /scope:\s*\["identify", "guilds"\]/)
  const { ctx, opts, calls } = oauthFixture()
  opts.account.providerId = 'discord'
  opts.disableSignUp = false
  const result = await handleOAuthUserInfo(ctx, opts)
  assert.equal(result.error, null)
  assert.equal(result.isRegister, true)
  assert.deepEqual(calls, { users: 1, sessions: 1, updates: 0 })
})

test('Google linking stays explicit, and errors and Google-only guidance are safe', async () => {
  const [auth, callback, connections, page, button] = await Promise.all([
    source('lib/auth.ts'), source('node_modules/better-auth/dist/api/routes/callback.mjs'),
    source('components/account-connections.tsx'), source('app/auth-error/page.tsx'),
    source('components/auth-error-discord-button.tsx'),
  ])
  assert.match(auth, /disableImplicitLinking:\s*true/)
  assert.match(auth, /allowDifferentEmails:\s*true/)
  assert.match(connections, /authClient\.linkSocial\(/)
  assert.match(connections, /Discordを連携するとサーバー機能を利用できます/)
  assert.match(connections, /!loading && isLinked\('google'\) && !isLinked\('discord'\)/)
  assert.match(connections, /errorCallbackURL: `\/auth-error\?provider=\$\{provider\}`/)
  assert.ok(callback.indexOf('if (link) {') < callback.indexOf('disableSignUp: provider.disableImplicitSignUp'))
  assert.match(callback, /disableSignUp: provider\.disableImplicitSignUp && !requestSignUp \|\| provider\.options\?\.disableSignUp/)
  assert.match(page, /error === 'signup_disabled'/)
  assert.match(page, /provider === 'google' && error === 'account_not_linked'/)
  assert.match(page, /Googleは追加のログイン方法です。初回利用にはDiscordアカウントが必要です/)
  assert.match(page, /このDiscordアカウントには既存のNuviloViewアカウントがあります/)
  assert.doesNotMatch(page, /\{error\}|dangerouslySetInnerHTML/)
  assert.match(button, /provider: 'discord'/)
  assert.match(button, /Discordで続行/)
})
