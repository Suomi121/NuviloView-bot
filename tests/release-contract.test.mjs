import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkSource, checkEnvironment, checkBuild, requirements } from '../scripts/production-contract.mjs'
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
test('build route gate fails closed for missing routes', () => {
  const missing = checkBuild({})
  assert.equal(missing.length, 7)
  const manifest = Object.fromEntries(missing.map(message => [message.slice('Build missing: '.length), 'page.js']))
  assert.deepEqual(checkBuild(manifest), [])
  delete manifest['/account/page']; assert.equal(checkBuild(manifest).length, 1)
})
test('current production source contract passes', () => assert.deepEqual(checkSource(read), []))
for (const [name, path] of requirements) test(`release gate rejects removal: ${name}`, () => {
  assert.ok(checkSource(file => file === path ? '' : read(file)).length)
})
test('security floor cannot regress', () => {
  const pkg = JSON.parse(read('package.json')); pkg.dependencies.next = '16.3.3'
  assert.ok(checkSource(file => file === 'package.json' ? JSON.stringify(pkg) : read(file)).length)
})
test('metadata gate does not accept values or Preview-only credentials', () => {
  assert.ok(checkEnvironment([{ key: 'DATABASE_URL', value: 'not-a-secret', target: ['production'] }]).length)
  assert.ok(checkEnvironment([{ key: 'DATABASE_URL', target: ['preview'] }]).length)
  assert.ok(checkEnvironment([]).length)
})
test('metadata gate accepts complete production names and both Discord aliases', () => {
  const names = ['DATABASE_URL','BETTER_AUTH_SECRET','BETTER_AUTH_URL','WEB_AUTH_DB_PROVIDER','WEB_AUTH_SUPABASE_DATABASE_URL','NUVILOVIEW_GOOGLE_CLIENT_ID','NUVILOVIEW_GOOGLE_CLIENT_SECRET','DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET']
  const metadata = names.map(key => ({ key, target: ['production'] }))
  assert.deepEqual(checkEnvironment(metadata), [])
  metadata[0].target = ['preview']; assert.ok(checkEnvironment(metadata).length)
})
