import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createSocialLoginState, retryDelaySeconds } from '../lib/social-login-state.mjs'
import { createAuthClient } from 'better-auth/client'

test('installed Better Auth client passes 429 headers to the shared guard without a retry', async () => {
  let requests = 0
  const client = createAuthClient({
    baseURL: 'http://localhost:3000',
    fetchOptions: { customFetchImpl: async () => {
      requests++
      return new Response(JSON.stringify({ message: 'Too many requests' }), {
        status: 429, headers: { 'content-type': 'application/json', 'X-Retry-After': '8' },
      })
    } },
  })
  const state = createSocialLoginState(() => 1000)
  assert.equal(await state.run(options => client.signIn.social({ provider: 'discord', callbackURL: '/dashboard' }, options)), 'rate-limited')
  assert.equal(state.getSnapshot().retryAt, 9000)
  assert.equal(requests, 1)
})

test('retry delay accepts standard and Better Auth headers and safe fallback', () => {
  assert.equal(retryDelaySeconds(new Headers({ 'Retry-After': '12' })), 12)
  assert.equal(retryDelaySeconds(new Headers({ 'X-Retry-After': '7' })), 7)
  assert.equal(retryDelaySeconds(new Headers({ 'Retry-After': 'Thu, 01 Jan 1970 00:00:20 GMT' }), 10000), 10)
  for (const value of ['garbage', '-1', 'Infinity']) {
    assert.equal(retryDelaySeconds(new Headers({ 'X-Retry-After': value })), 10)
  }
  assert.equal(retryDelaySeconds(), 10)
  assert.equal(retryDelaySeconds(new Headers({ 'Retry-After': '0' })), 1)
})

test('429 keeps server delay, blocks all entry points and never auto-retries', async () => {
  let time = 1000
  const state = createSocialLoginState(() => time)
  let calls = 0
  const request = async (options) => {
    calls++
    assert.equal(options.retry, 0)
    options.onError({ response: new Response(null, { status: 429, headers: { 'X-Retry-After': '15' } }) })
    return { error: { status: 429, message: 'raw private error must not be surfaced' } }
  }
  assert.equal(await state.run(request), 'rate-limited')
  assert.equal(state.getSnapshot().retryAt, 16000)
  assert.equal(await state.run(request), 'rate-limited')
  assert.equal(calls, 1)
  time = 16000
  assert.equal(await state.run(async () => { calls++; return { data: {} } }), 'success')
  assert.equal(calls, 2)
})

test('synchronous shared lock prevents rapid clicks and separate mounted buttons', async () => {
  const state = createSocialLoginState()
  let complete
  const first = state.run(() => new Promise(resolve => { complete = resolve }))
  assert.equal(state.getSnapshot().pending, true)
  assert.equal(await state.run(() => assert.fail('duplicate request')), 'busy')
  complete({ data: {} })
  assert.equal(await first, 'success')
  assert.equal(state.getSnapshot().pending, false)
})

test('missing headers still protect retry and ordinary errors release the lock', async () => {
  const state = createSocialLoginState(() => 0)
  assert.equal(await state.run(async () => ({ error: { status: 429 } })), 'rate-limited')
  assert.equal(state.getSnapshot().retryAt, 10000)
  const ordinary = createSocialLoginState()
  assert.equal(await ordinary.run(async () => { throw new Error('private details') }), 'error')
  assert.equal(ordinary.getSnapshot().pending, false)
  assert.equal(await ordinary.run(async () => ({ error: { status: 503 } })), 'error')
})

test('UI treats rate limit separately without changing server auth protections', async () => {
  for (const path of ['components/login-button.tsx', 'components/auth-error-discord-button.tsx']) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(source, /useSocialLogin/)
    assert.match(source, /result === 'error'/)
    assert.match(source, /login\.seconds > 0/)
    assert.match(source, /role="status"/)
  }
  const errorPage = await readFile(new URL('../app/auth-error/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(errorPage, /認証用データベースへ接続できませんでした/)
  const auth = await readFile(new URL('../lib/auth.ts', import.meta.url), 'utf8')
  assert.match(auth, /disableImplicitLinking: true/)
  assert.match(auth, /disableSignUp: true/)
  assert.doesNotMatch(auth, /rateLimit:/)
})
