import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const execute = process.argv.includes("--execute");
const policyArgument = process.argv.find((argument) => argument.startsWith("--policy="));
const selectedPolicy = policyArgument?.slice("--policy=".length) || null;
const batchArgument = process.argv.find((argument) => argument.startsWith("--batch-size="));
const parsedBatchSize = Number.parseInt(batchArgument?.slice("--batch-size=".length) || "250", 10);

if (!Number.isInteger(parsedBatchSize) || parsedBatchSize < 1 || parsedBatchSize > 1000) {
  throw new Error("--batch-size must be an integer from 1 through 1000.");
}

// Identifiers and predicates are reviewed constants. Runtime input can select a
// policy and batch size, but it can never inject a table, column, or predicate.
export const RETENTION_POLICIES = [
  {
    id: "api-rate-limit",
    table: "api_rate_limit",
    timestamp: "bucketStart",
    keyColumns: ["key", "bucketStart"],
    days: 7,
    requiredIndex: "api_rate_limit_bucket_start_idx",
    predicate: "TRUE",
  },
  {
    id: "recent-activity",
    table: "recent_activity",
    timestamp: "occurredAt",
    keyColumns: ["id"],
    days: 90,
    requiredIndex: "recent_activity_retention_idx",
    predicate: "TRUE",
  },
  {
    id: "discord-message",
    table: "discord_message",
    timestamp: "createdAt",
    keyColumns: ["id"],
    days: 90,
    requiredIndex: "discord_message_retention_idx",
    predicate: "TRUE",
  },
  {
    id: "service-heartbeat",
    table: "service_heartbeat",
    timestamp: "lastHeartbeatAt",
    keyColumns: ["instanceId"],
    days: 30,
    requiredIndex: "service_heartbeat_retention_idx",
    predicate: `"stoppedAt" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "service_lease" lease
      WHERE lease."ownerInstanceId" = target."instanceId"
        AND lease."leaseExpiresAt" > now()
    )`,
  },
  {
    id: "moderation-audit",
    table: "bot_moderation_audit",
    timestamp: "createdAt",
    keyColumns: ["id"],
    days: 365,
    requiredIndex: "bot_moderation_audit_retention_idx",
    predicate: `"status" <> 'pending'`,
  },
  {
    id: "daily-active-member",
    table: "daily_active_member",
    timestamp: "date",
    keyColumns: ["id"],
    days: 400,
    requiredIndex: "daily_active_member_retention_idx",
    predicate: "TRUE",
  },
  {
    id: "voice-session",
    table: "voice_session",
    timestamp: "endedAt",
    keyColumns: ["id"],
    days: 400,
    requiredIndex: "voice_session_retention_idx",
    predicate: `"endedAt" IS NOT NULL`,
  },
  {
    id: "voice-server-session",
    table: "voice_server_session",
    timestamp: "endedAt",
    keyColumns: ["id"],
    days: 400,
    requiredIndex: "voice_server_session_retention_idx",
    predicate: `"endedAt" IS NOT NULL`,
  },
  {
    id: "guild-member-event",
    table: "guild_member_event",
    timestamp: "occurredAt",
    keyColumns: ["id"],
    days: 400,
    requiredIndex: "guild_member_event_retention_idx",
    predicate: "TRUE",
  },
  {
    id: "reaction-event",
    table: "discord_reaction_event",
    timestamp: "occurredAt",
    keyColumns: ["id"],
    days: 400,
    requiredIndex: "discord_reaction_event_retention_idx",
    predicate: "TRUE",
  },
];

const policies = selectedPolicy
  ? RETENTION_POLICIES.filter((policy) => policy.id === selectedPolicy)
  : RETENTION_POLICIES;

if (selectedPolicy && policies.length === 0) {
  throw new Error(`Unknown retention policy: ${selectedPolicy}`);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildCandidateQuery(policy, mode) {
  const table = quoteIdentifier(policy.table);
  const timestamp = quoteIdentifier(policy.timestamp);
  const keyList = policy.keyColumns.map(quoteIdentifier).join(", ");
  const join = policy.keyColumns
    .map((column) => `target.${quoteIdentifier(column)} = candidate.${quoteIdentifier(column)}`)
    .join(" AND ");
  const candidate = `
    SELECT ${keyList}
    FROM ${table} target
    WHERE target.${timestamp} < now() - ($1::integer * interval '1 day')
      AND (${policy.predicate})
    ORDER BY target.${timestamp} ASC, ${policy.keyColumns.map((column) => `target.${quoteIdentifier(column)}`).join(", ")} ASC
    LIMIT $2`;

  if (mode === "plan") {
    return `WITH candidate AS (${candidate}) SELECT count(*)::integer AS "candidateCount" FROM candidate`;
  }
  return `WITH candidate AS (${candidate}) DELETE FROM ${table} target USING candidate WHERE ${join} RETURNING 1`;
}

async function indexExists(client, indexName) {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = ANY (current_schemas(false)) AND indexname = $1
    ) AS "exists"`,
    [indexName],
  );
  return result.rows[0]?.exists === true;
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
let lockAcquired = false;

try {
  const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('nuviloview.retention-cleanup.v1')) AS "acquired"`);
  lockAcquired = lock.rows[0]?.acquired === true;
  if (!lockAcquired) throw new Error("Another retention cleanup is already running.");

  const results = [];
  for (const policy of policies) {
    const hasIndex = await indexExists(client, policy.requiredIndex);
    if (execute && !hasIndex) {
      throw new Error(`Required index is missing for ${policy.id}: ${policy.requiredIndex}`);
    }

    if (!execute) {
      await client.query("BEGIN READ ONLY");
      try {
        await client.query(`SET LOCAL statement_timeout = '30s'`);
        const result = await client.query(buildCandidateQuery(policy, "plan"), [policy.days, parsedBatchSize]);
        await client.query("COMMIT");
        results.push({
          policy: policy.id,
          retentionDays: policy.days,
          candidateCount: result.rows[0]?.candidateCount ?? 0,
          batchLimit: parsedBatchSize,
          requiredIndex: policy.requiredIndex,
          indexPresent: hasIndex,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL lock_timeout = '3s'`);
      await client.query(`SET LOCAL statement_timeout = '30s'`);
      const result = await client.query(buildCandidateQuery(policy, "execute"), [policy.days, parsedBatchSize]);
      await client.query("COMMIT");
      results.push({
        policy: policy.id,
        retentionDays: policy.days,
        deletedCount: result.rowCount,
        batchLimit: parsedBatchSize,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", results }, null, 2));
} finally {
  if (lockAcquired) {
    await client.query(`SELECT pg_advisory_unlock(hashtext('nuviloview.retention-cleanup.v1'))`).catch(() => {});
  }
  client.release();
  await pool.end();
}
