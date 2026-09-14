import { APIError } from 'better-auth/api'
import type { Pool } from 'pg'

// Serializes only unlink operations for one user across server instances.
// Non-blocking lock avoids consuming the pool with waiting unlink requests.
// Better Auth still owns session freshness, ownership checks and the deletion.
export async function guardedUnlink(pool: Pool, accountId: string, remove: () => Promise<unknown>) {
  const client = await pool.connect()
  let lockKey: string | undefined
  let destroy = false
  try {
    const owner = await client.query('SELECT "userId" FROM account WHERE id=$1', [accountId])
    if (!owner.rows[0]) throw new APIError('BAD_REQUEST', { message: 'Account not found' })
    const key = `nuviloview-unlink:${owner.rows[0].userId}`
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key])
    if (!lock.rows[0].locked) throw new APIError('CONFLICT', { message: 'Another account operation is in progress' })
    lockKey = key
    const remaining = await client.query('SELECT count(*)::int AS n FROM account WHERE "userId"=$1 AND id<>$2 AND "providerId" IN (\'discord\', \'google\')', [owner.rows[0].userId, accountId])
    if (remaining.rows[0].n < 1) throw new APIError('BAD_REQUEST', { message: 'Cannot unlink the last login method' })
    return await remove()
  } finally {
    try {
      if (lockKey) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
    } catch {
      destroy = true // Never return a connection holding a session lock to the pool.
    }
    client.release(destroy)
  }
}
