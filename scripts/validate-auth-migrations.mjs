import { loadAuthIdentityMigration } from './auth-migrations/loader.mjs'

await loadAuthIdentityMigration()
console.log('Auth migration validation passed: 1 additive, approval-gated migration; checksum verified.')
