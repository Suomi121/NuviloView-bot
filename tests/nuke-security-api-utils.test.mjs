import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SECURITY_SCOPES,
  hasSecurityScope,
  isDiscordSnowflake,
  normalizeResolutionReason,
  normalizeTrustedActorInput,
  securityScopesForAccess,
} from '../lib/nuke-security-api-utils.mjs'

test('Discord-managed Guild administrator receives security mutation scopes', () => {
  const scopes = securityScopesForAccess({ managedGuild: true, guildOwner: false })
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.view), true)
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.policy), true)
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.contain), true)
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.restore), true)
})

test('guild owner receives separated security mutation scopes', () => {
  const scopes = securityScopesForAccess({ managedGuild: true, guildOwner: true })
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.view), true)
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.policy), true)
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.contain), true)
  assert.equal(hasSecurityScope(scopes, SECURITY_SCOPES.restore), true)
})

test('wrong guild receives no scopes', () => {
  assert.deepEqual(securityScopesForAccess({ managedGuild: false, guildOwner: true }), [])
})

test('platform developer receives scopes without weakening ordinary cross-Guild isolation', () => {
  const scopes = securityScopesForAccess({ managedGuild: false, guildOwner: false, platformDeveloper: true })
  assert.deepEqual(new Set(scopes), new Set(Object.values(SECURITY_SCOPES)))
  assert.deepEqual(securityScopesForAccess({ managedGuild: false, guildOwner: false }), [])
})

test('Discord IDs and trusted actor input are validated without accepting arbitrary values', () => {
  assert.equal(isDiscordSnowflake('123456789012345678'), true)
  assert.equal(isDiscordSnowflake('../guild'), false)
  assert.deepEqual(normalizeTrustedActorInput({ actorId: '123456789012345678', label: ' Deploy bot ', actorType: 'bot' }), {
    actorId: '123456789012345678', label: 'Deploy bot', actorType: 'bot',
  })
  assert.equal(normalizeTrustedActorInput({ actorId: 'invalid' }), null)
})

test('resolution reasons are optional and bounded', () => {
  assert.equal(normalizeResolutionReason('  reviewed  '), 'reviewed')
  assert.equal(normalizeResolutionReason(''), null)
  assert.equal(normalizeResolutionReason('x'.repeat(900))?.length, 500)
})
