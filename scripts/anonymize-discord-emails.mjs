import pg from 'pg'

const required = ['DATABASE_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} must be set before anonymizing Discord accounts.`)
}

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function revokeDiscordToken(token) {
  if (!token) return true
  const credentials = Buffer.from(`${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`).toString('base64')
  try {
    const response = await fetch('https://discord.com/api/v10/oauth2/token/revoke', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token }),
    })
    return response.ok
  } catch {
    return false
  }
}

try {
  const legacy = await pool.query(`
    SELECT DISTINCT ON (account."userId")
      account."userId", account."accountId", account."accessToken", account."refreshToken"
    FROM "account" AS account
    INNER JOIN "user" AS app_user ON app_user."id" = account."userId"
    WHERE account."providerId" = 'discord'
      AND app_user."email" IS DISTINCT FROM ('discord-' || account."accountId" || '@users.invalid')
    ORDER BY account."userId", account."updatedAt" DESC
  `)

  if (legacy.rowCount === 0) {
    console.log('No legacy Discord email addresses remain. Nothing changed.')
  } else {
    let revokeFailures = 0
    for (const row of legacy.rows) {
      const revoked = await revokeDiscordToken(row.refreshToken || row.accessToken)
      if (!revoked) revokeFailures += 1
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const row of legacy.rows) {
        const privateIdentity = `discord-${row.accountId}@users.invalid`
        await client.query(`
          UPDATE "user"
          SET "email" = $2, "emailVerified" = false, "updatedAt" = now()
          WHERE "id" = $1
        `, [row.userId, privateIdentity])
        await client.query(`
          UPDATE "account"
          SET "accessToken" = NULL, "refreshToken" = NULL, "idToken" = NULL,
              "accessTokenExpiresAt" = NULL, "refreshTokenExpiresAt" = NULL,
              "scope" = NULL, "updatedAt" = now()
          WHERE "userId" = $1 AND "providerId" = 'discord'
        `, [row.userId])
        await client.query('DELETE FROM "session" WHERE "userId" = $1', [row.userId])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    console.log(`Anonymized ${legacy.rowCount} Discord account(s), cleared OAuth tokens, and revoked active sessions.`)
    if (revokeFailures > 0) console.warn(`Discord token revocation could not be confirmed for ${revokeFailures} account(s); their stored tokens were still deleted.`)
  }
} finally {
  await pool.end()
}
