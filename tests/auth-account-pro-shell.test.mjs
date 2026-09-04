import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Google authentication is additive and Discord authorization scopes stay unchanged', async () => {
  const [auth, providerConfig, login, env] = await Promise.all([
    source('lib/auth.ts'),
    source('lib/auth-provider-config.ts'),
    source('components/login-button.tsx'),
    source('.env.example'),
  ])

  assert.match(auth, /google:\s*\{/)
  assert.match(auth, /scope:\s*\["openid", "email", "profile"\]/)
  assert.match(auth, /disableImplicitLinking:\s*true/)
  assert.match(auth, /allowDifferentEmails:\s*true/)
  assert.match(auth, /updateUserInfoOnLink:\s*false/)
  assert.match(auth, /allowUnlinkingAll:\s*false/)

  assert.match(auth, /disableDefaultScope:\s*true/)
  assert.match(auth, /scope:\s*\["identify", "guilds"\]/)
  assert.doesNotMatch(auth, /scope:\s*\[[^\]]*guilds[^\]]*email/)
  assert.match(login, /signIn\.social\(\{[\s\S]*?provider,/)
  assert.match(login, /errorCallbackURL:\s*'\/auth-error'/)

  assert.match(providerConfig, /NUVILOVIEW_GOOGLE_CLIENT_ID/)
  assert.match(providerConfig, /NUVILOVIEW_GOOGLE_CLIENT_SECRET/)
  assert.match(env, /\/api\/auth\/callback\/google/)
})

test('Account page reports real Better Auth links and only performs explicit linking', async () => {
  const [page, connections, discord] = await Promise.all([
    source('app/account/page.tsx'),
    source('components/account-connections.tsx'),
    source('lib/discord.ts'),
  ])

  assert.match(page, /auth\.api\.getSession/)
  assert.match(page, /redirect\('\/\?landing=1'\)/)
  assert.match(connections, /authClient\.listAccounts\(\)/)
  assert.match(connections, /account\.providerId === provider/)
  assert.match(connections, /authClient\.linkSocial\(/)
  assert.match(connections, /callbackURL:\s*'\/account'/)
  assert.doesNotMatch(connections, /unlinkAccount/)

  assert.match(discord, /getDiscordAccount\(userId\)/)
  assert.match(discord, /users\/@me\/guilds/)
  assert.match(discord, /MANAGE_GUILD/)
})

test('/pro is a presentation shell with no billing or entitlement implementation', async () => {
  const [page, packageJson] = await Promise.all([
    source('app/pro/page.tsx'),
    source('package.json'),
  ])

  assert.match(page, /Billingなし/)
  assert.match(page, /現在は課金、決済、サブスクリプション、Pro権限の付与を行いません/)
  assert.doesNotMatch(page, /checkoutSession|paymentIntent|subscriptionId|priceId/)
  assert.doesNotMatch(packageJson, /stripe|paddle|lemonsqueezy/i)
})

test('provider status response exposes booleans without credentials', async () => {
  const route = await source('app/api/auth-provider-status/route.ts')
  assert.match(route, /getAuthProviderAvailability\(\)/)
  assert.doesNotMatch(route, /clientSecret|GOOGLE_CLIENT_SECRET|NUVILOVIEW_CLIENT_SECRET/)
})
