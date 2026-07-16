import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const ignored = new Set(['.git', '.next', 'node_modules', 'logs', '.vercel'])
const ignoredFiles = new Set(['.env', '.env.local', '.env.production', '.env.development'])
const tokenPattern = /(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})/g
const findings = []

async function scan(directory) {
  for (const entry of await readdir(directory)) {
    if (ignored.has(entry) || ignoredFiles.has(entry)) continue
    const file = join(directory, entry)
    const info = await stat(file)
    if (info.isDirectory()) await scan(file)
    else if (info.size <= 1_000_000 && /\.(?:[cm]?[jt]sx?|json|md|ya?ml|ps1|txt)$/i.test(entry)) {
      const text = await readFile(file, 'utf8').catch(() => '')
      if (tokenPattern.test(text)) findings.push(relative(root, file))
      tokenPattern.lastIndex = 0
    }
  }
}

await scan(root)
if (findings.length) {
  console.error(`Token leak check failed: potential Discord token found in ${findings.join(', ')}. The token value was not printed.`)
  process.exit(1)
}
console.log('Token leak check passed: no potential Discord tokens found outside ignored secret files.')
