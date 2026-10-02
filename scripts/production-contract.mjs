import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Source presence is a release floor, not a substitute for behavioral tests or OAuth smoke.
export const requirements = [
  ['Landing', 'app/page.tsx', []],
  ['Dashboard', 'app/dashboard/page.tsx', ['SecurityNavigationLink']],
  ['Account', 'app/account/page.tsx', []],
  ['Account connections', 'components/account-connections.tsx', ['linkSocial', 'unlinkAccount']],
  ['Auth route', 'app/api/auth/[...all]/route.ts', []],
  ['Auth providers', 'lib/auth-provider-config.ts', ['discord:', 'google:']],
  ['Auth implementation', 'lib/auth.ts', ['socialProviders', 'accountLinking']],
  ['Guild authorization', 'lib/discord.ts', []],
  ['Spam page', 'app/dashboard/security/spam/page.tsx', []],
  ['Spam API', 'app/api/guilds/[guildId]/security/spam-policy/route.ts', []],
  ['Security navigation', 'components/security-navigation-link.tsx', ['/dashboard/security/spam', 'bg-gradient-to-r']],
  ['Rate limit UX', 'lib/social-login-state.mjs', ['429', 'retry: 0']],
  ['Rate limit hook', 'lib/use-social-login.ts', []],
  ['Bot commands/onboarding', 'discord-bot.mjs', ['.setName("spamprotection")', 'createGuildOnboarding', 'guildCreate']],
  ['Onboarding', 'lib/guild-onboarding.mjs', []],
  ['Supervisor recovery', 'lib/sync/worker-supervisor.mjs', ['superviseWorker']],
  ['Diagnostics', 'lib/sync/worker-diagnostics.mjs', []],
  ['Worker runner', 'Android/run-sync-worker-forever.sh', ['supervise-sync-worker.mjs']],
  ['Worker', 'scripts/run-sync-worker.mjs', []],
  ['Crash preload', 'scripts/worker-crash-preload.mjs', []],
]
export function checkSource(read) {
  const failures = []
  for (const [feature, file, tokens] of requirements) {
    let source
    try { source = read(file) } catch { failures.push(`${feature}: missing ${file}`); continue }
    if (!source.trim() || tokens.some(token => !source.includes(token))) failures.push(`${feature}: incomplete ${file}`)
  }
  const dashboard = read('app/dashboard/page.tsx')
  if ((dashboard.match(/<SecurityNavigationLink\b/g) ?? []).length !== 2) failures.push('Security navigation: desktop and mobile required')
  const pkg = JSON.parse(read('package.json'))
  const parts = pkg.dependencies.next.split('.').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN) || parts[0] < 16 || (parts[0] === 16 && (parts[1] < 3 || (parts[1] === 3 && parts[2] < 8)))) failures.push('Next.js security floor: 16.3.8')
  return failures
}

// Accept ONLY pre-redacted metadata. Never accept an environment export/value.
export function checkEnvironment(metadata) {
  if (!Array.isArray(metadata) || metadata.some(e => !e || Object.keys(e).some(k => !['key', 'target', 'gitBranch'].includes(k)) || typeof e.key !== 'string' || !Array.isArray(e.target))) return ['Invalid metadata: only key/target/gitBranch allowed']
  const required = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'WEB_AUTH_DB_PROVIDER', 'WEB_AUTH_SUPABASE_DATABASE_URL', 'NUVILOVIEW_GOOGLE_CLIENT_ID', 'NUVILOVIEW_GOOGLE_CLIENT_SECRET']
  const has = key => metadata.some(e => e.key === key && e.target.includes('production') && !e.gitBranch)
  const errors = required.filter(k => !has(k)).map(k => `Production missing: ${k}`)
  for (const names of [['NUVILOVIEW_CLIENT_ID', 'DISCORD_CLIENT_ID'], ['NUVILOVIEW_CLIENT_SECRET', 'DISCORD_CLIENT_SECRET']]) if (!names.some(has)) errors.push(`Production missing: ${names.join(' or ')}`)
  return errors
}
export function checkBuild(manifest) {
  return ['/account/page', '/api/account-connections/route', '/api/auth/[...all]/route', '/api/auth-provider-status/route', '/dashboard/page', '/dashboard/security/spam/page', '/api/guilds/[guildId]/security/spam-policy/route']
    .filter(route => typeof manifest[route] !== 'string').map(route => `Build missing: ${route}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const failures = process.argv.includes('--env-metadata-stdin')
      ? checkEnvironment(JSON.parse(readFileSync(0, 'utf8')))
      : process.argv.includes('--build') ? checkBuild(JSON.parse(readFileSync('.next/server/app-paths-manifest.json', 'utf8')))
      : checkSource(file => readFileSync(resolve(file), 'utf8'))
    for (const failure of failures) console.error(failure)
    console.log(failures.length ? 'Release contract: FAIL' : 'Release contract: PASS')
    process.exitCode = failures.length ? 1 : 0
  } catch { console.error('Release contract: invalid or missing input (content withheld)'); process.exitCode = 1 }
}
