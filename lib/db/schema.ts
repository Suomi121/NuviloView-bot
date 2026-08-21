import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  date,
  serial,
  uniqueIndex,
  index,
  jsonb,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";

// --- Better Auth required tables -------------------------------------------
// Column names are camelCase to match Better Auth's defaults. Do not rename.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Better Auth 1.x requires this field to be non-null. Discord accounts use
  // a generated `discord-<id>@users.invalid` identity key, never the user's
  // actual Discord email address.
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

// --- App tables ------------------------------------------------------------
// Per-user OEM / white-label branding settings. Scoped by userId (no FK by
// default per the Neon stack conventions).

export const branding = pgTable("branding", {
  userId: text("userId").primaryKey(),
  brandName: text("brandName").notNull().default("NuviloView:OEM"),
  logoUrl: text("logoUrl"),
  accentColor: text("accentColor").notNull().default("#5865F2"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// Short-lived authorization cache for Discord's managed-guild endpoint. This
// prevents every protected dashboard request from consuming Discord API quota.
export const discordManagedGuildCache = pgTable("discord_managed_guild_cache", {
  userId: text("userId").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  guilds: jsonb("guilds").notNull().default([]),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
});

export const guildTheme = pgTable("guild_theme", {
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  guildId: text("guildId").notNull(),
  mode: text("mode").notNull().default("dark"),
  primaryColor: text("primaryColor").notNull().default("#6677ff"),
  accentColor: text("accentColor").notNull().default("#9b8cff"),
  backgroundColor: text("backgroundColor").notNull().default("#111116"),
  cardColor: text("cardColor").notNull().default("#1c1c24"),
  radius: text("radius").notNull().default("default"),
  brandName: text("brandName").notNull().default("NuviloView:OEM"),
  logoUrl: text("logoUrl"),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("guild_theme_user_guild_unique").on(table.userId, table.guildId)]);

// Daily, per-server aggregates written by the Discord bot.
export const dailyStats = pgTable(
  "daily_stats",
  {
    id: serial("id").primaryKey(),
    guildId: text("guildId").notNull(),
    memberCount: integer("memberCount").notNull().default(0),
    messageCount: integer("messageCount").notNull().default(0),
    reactionCount: integer("reactionCount").notNull().default(0),
    date: date("date").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("daily_stats_guild_date_unique").on(table.guildId, table.date),
  ],
);

export const dailyActiveMember = pgTable(
  "daily_active_member",
  {
    id: serial("id").primaryKey(),
    guildId: text("guildId").notNull(),
    userId: text("userId").notNull(),
    date: date("date").notNull(),
  },
  (table) => [
    uniqueIndex("daily_active_member_guild_user_date_unique").on(
      table.guildId,
      table.userId,
      table.date,
    ),
  ],
);

// Privacy-conscious event feed: no message body is stored.
export const recentActivity = pgTable("recent_activity", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  type: text("type").notNull(),
  actorName: text("actorName").notNull(),
  channelName: text("channelName"),
  occurredAt: timestamp("occurredAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userPreference = pgTable("user_preference", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  timeZone: text("timeZone").notNull().default("Asia/Tokyo"),
  language: text("language").notNull().default("ja"),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const supportRequest = pgTable("support_request", {
  id: serial("id").primaryKey(),
  userId: text("userId"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Stored only to support server-authorized message search.
export const discordMessage = pgTable("discord_message", {
  id: text("id").primaryKey(),
  guildId: text("guildId").notNull(),
  channelId: text("channelId"),
  channelName: text("channelName").notNull(),
  authorId: text("authorId").notNull(),
  authorName: text("authorName").notNull(),
  authorIsBot: boolean("authorIsBot").notNull().default(false),
  // Event-time roles only. Existing rows remain an empty array rather than
  // applying a member's current roles retroactively to historical activity.
  authorRoleIds: jsonb("authorRoleIds").notNull().default([]),
  content: text("content").notNull(),
  // Existing rows cannot be reliably classified retroactively. New gateway
  // and v2 import writes explicitly use live or history_import.
  source: text("source").notNull().default("existing"),
  importJobId: integer("importJobId"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("discord_message_guild_source_created_idx").on(table.guildId, table.source, table.createdAt),
]);

// A session starts when a non-bot member joins a voice channel and ends when
// they leave voice altogether. Moving between voice channels is continuous.
export const voiceSession = pgTable("voice_session", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  userId: text("userId").notNull(),
  channelId: text("channelId").notNull(),
  userIsBot: boolean("userIsBot").notNull().default(false),
  userRoleIds: jsonb("userRoleIds").notNull().default([]),
  startedAt: timestamp("startedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("endedAt", { withTimezone: true }),
});

// Join/leave history is intentionally separate from the human-readable
// activity feed: retention requires stable Discord IDs, bot flags and
// repeated join cycles while the feed remains privacy-conscious.
export const guildMemberEvent = pgTable("guild_member_event", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  userId: text("userId").notNull(),
  eventType: text("eventType").notNull(),
  isBot: boolean("isBot").notNull().default(false),
  roleIds: jsonb("roleIds").notNull().default([]),
  source: text("source").notNull().default("gateway"),
  occurredAt: timestamp("occurredAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("guild_member_event_guild_occurred_idx").on(table.guildId, table.occurredAt),
  index("guild_member_event_guild_user_occurred_idx").on(table.guildId, table.userId, table.occurredAt),
]);

export const discordReactionEvent = pgTable("discord_reaction_event", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  channelId: text("channelId"),
  messageId: text("messageId").notNull(),
  reactorId: text("reactorId").notNull(),
  recipientId: text("recipientId"),
  reactorIsBot: boolean("reactorIsBot").notNull().default(false),
  reactorRoleIds: jsonb("reactorRoleIds").notNull().default([]),
  occurredAt: timestamp("occurredAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("discord_reaction_event_guild_occurred_idx").on(table.guildId, table.occurredAt),
  index("discord_reaction_event_guild_channel_occurred_idx").on(table.guildId, table.channelId, table.occurredAt),
]);

// Inventories preserve names for deleted objects and keep current role member
// counts separate from event-time role snapshots used by historical analysis.
export const guildChannelRegistry = pgTable("guild_channel_registry", {
  guildId: text("guildId").notNull(),
  channelId: text("channelId").notNull(),
  channelName: text("channelName").notNull(),
  channelType: text("channelType").notNull(),
  deletedAt: timestamp("deletedAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("guild_channel_registry_guild_channel_unique").on(table.guildId, table.channelId),
  index("guild_channel_registry_guild_updated_idx").on(table.guildId, table.updatedAt),
]);

export const guildRoleRegistry = pgTable("guild_role_registry", {
  guildId: text("guildId").notNull(),
  roleId: text("roleId").notNull(),
  roleName: text("roleName").notNull(),
  memberCount: integer("memberCount").notNull().default(0),
  isManaged: boolean("isManaged").notNull().default(false),
  isBotRole: boolean("isBotRole").notNull().default(false),
  isEveryone: boolean("isEveryone").notNull().default(false),
  color: integer("color").notNull().default(0),
  position: integer("position").notNull().default(0),
  deletedAt: timestamp("deletedAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("guild_role_registry_guild_role_unique").on(table.guildId, table.roleId),
  index("guild_role_registry_guild_position_idx").on(table.guildId, table.position),
]);

// A small daily cache provides score history without sending or recalculating
// raw events in the browser. Missing categories are recorded as null.
export const analyticsHealthSnapshot = pgTable("analytics_health_snapshot", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  date: date("date").notNull(),
  periodDays: integer("periodDays").notNull(),
  score: integer("score"),
  confidence: text("confidence").notNull(),
  categories: jsonb("categories").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("analytics_health_snapshot_guild_date_period_unique").on(table.guildId, table.date, table.periodDays),
]);

// Server-level voice activity. Time advances once while at least one human is
// in any voice channel, regardless of how many members are connected.
export const voiceServerSession = pgTable("voice_server_session", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  startedAt: timestamp("startedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("endedAt", { withTimezone: true }),
});

// The bot refreshes this per-server channel permission snapshot on startup and
// periodically afterwards, so dashboard owners can spot missing read access.
export const botChannelAccess = pgTable(
  "bot_channel_access",
  {
    guildId: text("guildId").notNull(),
    channelId: text("channelId").notNull(),
    channelName: text("channelName").notNull(),
    canRead: boolean("canRead").notNull().default(false),
    checkedAt: timestamp("checkedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("bot_channel_access_guild_channel_unique").on(table.guildId, table.channelId)],
);

// Minimal security record used to prevent the Bot from rejoining a server that
// has been explicitly blocked by the service operator.
export const botGuildBlocklist = pgTable("bot_guild_blocklist", {
  guildId: text("guildId").primaryKey(),
  reason: text("reason").notNull(),
  blockedBy: text("blockedBy").notNull(),
  blockedAt: timestamp("blockedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Immutable operational trail for developer block/unblock actions. Unlike the
// current blocklist, these rows remain after a server is unblocked.
export const botGuildBlockAudit = pgTable("bot_guild_block_audit", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  action: text("action").notNull(),
  reason: text("reason"),
  performedBy: text("performedBy").notNull(),
  performedByName: text("performedByName"),
  source: text("source").notNull().default("bot_command"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Every moderation command is recorded independently from analytics data.
// Pending rows are written before Discord is mutated so audit-storage failure
// fails closed instead of allowing an unlogged moderation action.
export const botModerationAudit = pgTable("bot_moderation_audit", {
  id: text("id").primaryKey(),
  guildId: text("guildId").notNull(),
  guildName: text("guildName"),
  action: text("action").notNull(),
  actorId: text("actorId").notNull(),
  actorName: text("actorName"),
  targetId: text("targetId"),
  targetName: text("targetName"),
  channelId: text("channelId"),
  reason: text("reason").notNull(),
  requestedCount: integer("requestedCount"),
  affectedCount: integer("affectedCount"),
  status: text("status").notNull().default("pending"),
  errorCode: text("errorCode"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completedAt", { withTimezone: true }),
}, (table) => [
  index("bot_moderation_audit_guild_created_idx").on(table.guildId, table.createdAt),
  index("bot_moderation_audit_actor_created_idx").on(table.actorId, table.createdAt),
]);

// Bot-maintained inventory. This lets the protected developer dashboard show
// real installation and connection information without calling Discord from
// the browser.
export const botGuildRegistry = pgTable("bot_guild_registry", {
  guildId: text("guildId").primaryKey(),
  name: text("name").notNull(),
  iconUrl: text("iconUrl"),
  ownerId: text("ownerId"),
  memberCount: integer("memberCount").notNull().default(0),
  isConnected: boolean("isConnected").notNull().default(true),
  lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Only aggregate character counts are kept to enforce the free translation
// allowance. Translation source text and results are never persisted.
export const translationUsage = pgTable("translation_usage", {
  month: date("month").primaryKey(),
  characterCount: integer("characterCount").notNull().default(0),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A single row updated by the running Bot. The public monitor route only
// exposes whether this timestamp is fresh; operational details stay private.
export const botHeartbeat = pgTable("bot_heartbeat", {
  id: text("id").primaryKey(),
  lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("startedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  guildCount: integer("guildCount").notNull().default(0),
  stoppedAt: timestamp("stoppedAt", { withTimezone: true }),
});

// Cross-host singleton ownership for the Discord Bot. A single conditional
// PostgreSQL upsert changes owner and increments the fencing token atomically.
export const serviceLease = pgTable("service_lease", {
  serviceKey: text("serviceKey").primaryKey(),
  ownerInstanceId: text("ownerInstanceId"),
  hostId: text("hostId"),
  fencingToken: bigint("fencingToken", { mode: "number" }).notNull().default(0),
  leaseExpiresAt: timestamp("leaseExpiresAt", { withTimezone: true }).notNull(),
  acquiredAt: timestamp("acquiredAt", { withTimezone: true }),
  renewedAt: timestamp("renewedAt", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
}, (table) => [
  index("service_lease_expiry_idx").on(table.leaseExpiresAt),
]);

// Administrator-configured self-service roles. A single message/emoji mapping
// may grant several bounded, non-privileged roles.
export const reactionRoleRule = pgTable("reaction_role_rule", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  channelId: text("channelId").notNull(),
  messageId: text("messageId").notNull(),
  emojiKey: text("emojiKey").notNull(),
  emojiDisplay: text("emojiDisplay").notNull(),
  roleIds: jsonb("roleIds").notNull().default([]),
  createdBy: text("createdBy").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("reaction_role_rule_target_unique").on(table.guildId, table.messageId, table.emojiKey),
  index("reaction_role_rule_guild_channel_idx").on(table.guildId, table.channelId),
]);

// Each process launch keeps a distinct row so operators can distinguish the
// active owner from stale, contended, or previously stopped instances.
export const serviceHeartbeat = pgTable("service_heartbeat", {
  instanceId: text("instanceId").primaryKey(),
  serviceKey: text("serviceKey")
    .notNull()
    .references(() => serviceLease.serviceKey, { onDelete: "restrict" }),
  hostId: text("hostId").notNull(),
  fencingToken: bigint("fencingToken", { mode: "number" }),
  platform: text("platform").notNull(),
  hostname: text("hostname").notNull(),
  pid: integer("pid").notNull(),
  startedAt: timestamp("startedAt", { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp("lastHeartbeatAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  status: text("status").notNull(),
  leaseState: text("leaseState").notNull(),
  appVersion: text("appVersion").notNull(),
  runtimeVersion: text("runtimeVersion").notNull(),
  commitSha: text("commitSha"),
  guildCount: integer("guildCount").notNull().default(0),
  metadata: jsonb("metadata").notNull().default({}),
  stoppedAt: timestamp("stoppedAt", { withTimezone: true }),
}, (table) => [
  index("service_heartbeat_service_last_idx").on(table.serviceKey, table.lastHeartbeatAt),
  index("service_heartbeat_host_last_idx").on(table.hostId, table.lastHeartbeatAt),
  index("service_heartbeat_service_started_idx").on(table.serviceKey, table.startedAt),
]);

// Append-only journal used by the reviewed migration runner. It stores only
// migration metadata and checksums, never credentials or application data.
export const schemaMigration = pgTable("schema_migration", {
  id: text("id").primaryKey(),
  checksum: text("checksum").notNull(),
  description: text("description").notNull(),
  risk: text("risk").notNull(),
  appliedAt: timestamp("appliedAt", { withTimezone: true }).notNull().defaultNow(),
  appliedBy: text("appliedBy").notNull(),
});

// Persistent backing for the distributed API rate limiter.
export const apiRateLimit = pgTable("api_rate_limit", {
  key: text("key").notNull(),
  bucketStart: timestamp("bucketStart", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.key, table.bucketStart] }),
  index("api_rate_limit_bucket_start_idx").on(table.bucketStart),
]);

// Notifications are scoped to the signed-in dashboard user. Deletion is soft so
// an acknowledged Bot warning does not immediately reappear on the next refresh.
export const userNotification = pgTable("user_notification", {
  id: serial("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  guildId: text("guildId").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deletedAt", { withTimezone: true }),
});

// Operational alerts are created by the Bot per guild. Dashboard notifications
// are derived from these rows for every authorized manager, so no Discord
// account details need to be exposed to the Bot.
export const guildAlertEvent = pgTable("guild_alert_event", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  type: text("type").notNull(),
  severity: text("severity").notNull().default("warning"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
});

// Goals are personal to a signed-in manager, but scoped to one Discord guild.
// This prevents one administrator from silently changing another's targets.
export const guildGoal = pgTable("guild_goal", {
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  guildId: text("guildId").notNull(),
  type: text("type").notNull(),
  target: integer("target").notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("guild_goal_user_guild_type_unique").on(table.userId, table.guildId, table.type)]);


// A dashboard user can request a bounded, rate-limited import of messages that
// existed before the bot was added. The local bot claims and processes jobs.
export const historyImportJob = pgTable("history_import_job", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  requestedBy: text("requestedBy")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  days: integer("days").notNull(),
  mode: text("mode").notNull().default("standard"),
  version: integer("version").notNull().default(1),
  source: text("source").notNull().default("legacy"),
  status: text("status").notNull().default("queued"),
  processedMessages: integer("processedMessages").notNull().default(0),
  failedChannels: integer("failedChannels").notNull().default(0),
  totalChannels: integer("totalChannels").notNull().default(0),
  completedChannels: integer("completedChannels").notNull().default(0),
  skippedChannels: integer("skippedChannels").notNull().default(0),
  estimatedMessages: integer("estimatedMessages"),
  fetchedMessages: integer("fetchedMessages").notNull().default(0),
  insertedMessages: integer("insertedMessages").notNull().default(0),
  duplicateMessages: integer("duplicateMessages").notNull().default(0),
  failedMessages: integer("failedMessages").notNull().default(0),
  currentChannelId: text("currentChannelId"),
  cancelRequested: boolean("cancelRequested").notNull().default(false),
  pauseRequested: boolean("pauseRequested").notNull().default(false),
  safeErrorCode: text("safeErrorCode"),
  safeErrorSummary: text("safeErrorSummary"),
  retryState: text("retryState"),
  retryAfterAt: timestamp("retryAfterAt", { withTimezone: true }),
  lastApiResponseAt: timestamp("lastApiResponseAt", { withTimezone: true }),
  lastDbWriteAt: timestamp("lastDbWriteAt", { withTimezone: true }),
  lastProgressAt: timestamp("lastProgressAt", { withTimezone: true }),
  lastWorkerHeartbeatAt: timestamp("lastWorkerHeartbeatAt", { withTimezone: true }),
  workerHostId: text("workerHostId"),
  workerInstanceId: text("workerInstanceId"),
  requestedAt: timestamp("requestedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("startedAt", { withTimezone: true }),
  pausedAt: timestamp("pausedAt", { withTimezone: true }),
  cancelledAt: timestamp("cancelledAt", { withTimezone: true }),
  failedAt: timestamp("failedAt", { withTimezone: true }),
  completedAt: timestamp("completedAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  resetAt: timestamp("resetAt", { withTimezone: true }),
  resetBy: text("resetBy"),
  error: text("error"),
}, (table) => [
  index("history_import_job_guild_requested_idx").on(table.guildId, table.requestedAt),
  index("history_import_job_status_progress_idx").on(table.status, table.lastProgressAt),
  index("history_import_job_terminal_completed_idx")
    .on(table.completedAt)
    .where(sql`${table.status} in ('cancelled', 'completed', 'failed')`),
  uniqueIndex("history_import_job_one_active_per_guild_v2_idx")
    .on(table.guildId)
    .where(sql`${table.status} in ('queued', 'preparing', 'running', 'pausing', 'paused', 'cancelling', 'stalled')`),
]);

export const historyImportChannelProgress = pgTable("history_import_channel_progress", {
  id: serial("id").primaryKey(),
  jobId: integer("jobId").notNull().references(() => historyImportJob.id, { onDelete: "cascade" }),
  guildId: text("guildId").notNull(),
  channelId: text("channelId").notNull(),
  channelName: text("channelName").notNull(),
  status: text("status").notNull().default("pending"),
  skipReason: text("skipReason"),
  nextBeforeMessageId: text("nextBeforeMessageId"),
  oldestMessageId: text("oldestMessageId"),
  fetchedCount: integer("fetchedCount").notNull().default(0),
  insertedCount: integer("insertedCount").notNull().default(0),
  duplicateCount: integer("duplicateCount").notNull().default(0),
  failedCount: integer("failedCount").notNull().default(0),
  skipRequested: boolean("skipRequested").notNull().default(false),
  retryCount: integer("retryCount").notNull().default(0),
  retryAfterAt: timestamp("retryAfterAt", { withTimezone: true }),
  lastApiResponseAt: timestamp("lastApiResponseAt", { withTimezone: true }),
  lastDbWriteAt: timestamp("lastDbWriteAt", { withTimezone: true }),
  lastProgressAt: timestamp("lastProgressAt", { withTimezone: true }),
  startedAt: timestamp("startedAt", { withTimezone: true }),
  completedAt: timestamp("completedAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  safeErrorCode: text("safeErrorCode"),
  safeErrorSummary: text("safeErrorSummary"),
}, (table) => [
  uniqueIndex("history_import_channel_job_channel_unique").on(table.jobId, table.channelId),
  index("history_import_channel_job_status_idx").on(table.jobId, table.status, table.updatedAt),
  index("history_import_channel_guild_channel_idx").on(table.guildId, table.channelId),
]);

export const messageImportAuditEvent = pgTable("message_import_audit_event", {
  id: serial("id").primaryKey(),
  jobId: integer("jobId"),
  guildId: text("guildId").notNull(),
  channelId: text("channelId"),
  eventType: text("eventType").notNull(),
  actorId: text("actorId"),
  counts: jsonb("counts").notNull().default({}),
  safeErrorCode: text("safeErrorCode"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("message_import_audit_guild_created_idx").on(table.guildId, table.createdAt),
  index("message_import_audit_job_created_idx").on(table.jobId, table.createdAt),
  index("message_import_audit_created_idx").on(table.createdAt),
]);

// Developer-only destructive reset controls. These tables are intentionally
// isolated from analytics data so the feature can remain disabled without
// affecting normal Bot collection or dashboard reads.
export const guildResetSettings = pgTable("guild_reset_settings", {
  guildId: text("guildId").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  protectedChannelIds: jsonb("protectedChannelIds").notNull().default([]),
  protectedRoleIds: jsonb("protectedRoleIds").notNull().default([]),
  resetLogChannelId: text("resetLogChannelId"),
  backupChannelId: text("backupChannelId"),
  allowedAdminIds: jsonb("allowedAdminIds").notNull().default([]),
  maxChannelDeletes: integer("maxChannelDeletes"),
  maxRoleDeletes: integer("maxRoleDeletes"),
  maxTotalOperations: integer("maxTotalOperations"),
  guildCooldownHours: integer("guildCooldownHours"),
  developerCooldownMinutes: integer("developerCooldownMinutes"),
  defaultMode: text("defaultMode").notNull().default("channels_only"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
});

export const guildResetPlan = pgTable("guild_reset_plan", {
  id: text("id").primaryKey(),
  guildId: text("guildId").notNull(),
  developerId: text("developerId").notNull(),
  developerName: text("developerName"),
  mode: text("mode").notNull(),
  dryRun: boolean("dryRun").notNull().default(true),
  requestedOptions: jsonb("requestedOptions").notNull(),
  targetSnapshotHash: text("targetSnapshotHash").notNull(),
  targetSummary: jsonb("targetSummary").notNull(),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp("usedAt", { withTimezone: true }),
}, (table) => [
  index("guild_reset_plan_guild_created_idx").on(table.guildId, table.createdAt),
  index("guild_reset_plan_developer_created_idx").on(table.developerId, table.createdAt),
]);

export const guildResetConfirmation = pgTable("guild_reset_confirmation", {
  id: text("id").primaryKey(),
  planId: text("planId").notNull(),
  guildId: text("guildId").notNull(),
  developerId: text("developerId").notNull(),
  codeHash: text("codeHash").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  usedAt: timestamp("usedAt", { withTimezone: true }),
  usedByRequestId: text("usedByRequestId"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("guild_reset_confirmation_plan_created_idx").on(table.planId, table.createdAt),
]);

export const guildResetExecution = pgTable("guild_reset_execution", {
  id: text("id").primaryKey(),
  planId: text("planId").notNull(),
  guildId: text("guildId").notNull(),
  developerId: text("developerId").notNull(),
  developerName: text("developerName"),
  mode: text("mode").notNull(),
  dryRun: boolean("dryRun").notNull().default(true),
  reason: text("reason").notNull(),
  source: text("source").notNull().default("bot_command"),
  status: text("status").notNull().default("running"),
  backupPath: text("backupPath"),
  requestedCount: integer("requestedCount").notNull().default(0),
  successCount: integer("successCount").notNull().default(0),
  failedCount: integer("failedCount").notNull().default(0),
  skippedCount: integer("skippedCount").notNull().default(0),
  operationStarted: boolean("operationStarted").notNull().default(false),
  beforeSummary: jsonb("beforeSummary"),
  afterSummary: jsonb("afterSummary"),
  errorSummary: text("errorSummary"),
  startedAt: timestamp("startedAt", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finishedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("guild_reset_execution_guild_created_idx").on(table.guildId, table.createdAt),
  index("guild_reset_execution_developer_created_idx").on(table.developerId, table.createdAt),
]);

export const guildResetExecutionItem = pgTable("guild_reset_execution_item", {
  id: serial("id").primaryKey(),
  executionId: text("executionId").notNull(),
  targetType: text("targetType").notNull(),
  targetId: text("targetId"),
  targetName: text("targetName"),
  action: text("action").notNull(),
  status: text("status").notNull(),
  errorCode: text("errorCode"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("guild_reset_execution_item_execution_idx").on(table.executionId, table.id),
]);

export const guildResetBackup = pgTable("guild_reset_backup", {
  id: text("id").primaryKey(),
  executionId: text("executionId").notNull(),
  planId: text("planId").notNull(),
  guildId: text("guildId").notNull(),
  fileName: text("fileName").notNull(),
  filePath: text("filePath").notNull(),
  fileSize: integer("fileSize").notNull(),
  checksum: text("checksum").notNull(),
  schemaVersion: integer("schemaVersion").notNull().default(1),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("guild_reset_backup_guild_created_idx").on(table.guildId, table.createdAt),
]);

export const guildResetLock = pgTable("guild_reset_lock", {
  scope: text("scope").primaryKey(),
  guildId: text("guildId").notNull(),
  executionId: text("executionId").notNull(),
  lockedAt: timestamp("lockedAt", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
});

// Vercel never receives the Bot token. Dashboard actions are therefore
// authenticated in the web app, stored without secrets, and claimed by the
// connected Bot through this bounded single-consumer queue.
export const guildResetRequest = pgTable("guild_reset_request", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  guildId: text("guildId").notNull(),
  developerId: text("developerId").notNull(),
  developerName: text("developerName"),
  payload: jsonb("payload").notNull(),
  confirmationId: text("confirmationId"),
  status: text("status").notNull().default("queued"),
  result: jsonb("result"),
  errorCode: text("errorCode"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimedAt", { withTimezone: true }),
  completedAt: timestamp("completedAt", { withTimezone: true }),
}, (table) => [
  index("guild_reset_request_status_created_idx").on(table.status, table.createdAt),
  index("guild_reset_request_guild_created_idx").on(table.guildId, table.createdAt),
]);

// Nuke Protection v1 is isolated from analytics and message storage. Evidence
// contains Discord IDs and administrative action metadata, never message body.
export const securityPolicy = pgTable("security_policy", {
  guildId: text("guildId").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  nukeProtectionMode: text("nukeProtectionMode").notNull().default("shadow"),
  mode: text("mode").notNull().default("shadow"),
  sensitivity: text("sensitivity").notNull().default("balanced"),
  alertEnabled: boolean("alertEnabled").notNull().default(true),
  alertChannelId: text("alertChannelId"),
  manualContainment: boolean("manualContainment").notNull().default(true),
  automaticContainment: boolean("automaticContainment").notNull().default(false),
  channelProtection: boolean("channelProtection").notNull().default(true),
  roleProtection: boolean("roleProtection").notNull().default(true),
  autoRestore: boolean("autoRestore").notNull().default(false),
  webhookProtection: boolean("webhookProtection").notNull().default(true),
  botSpamProtection: boolean("botSpamProtection").notNull().default(true),
  botDuplicateSpam: boolean("botDuplicateSpam").notNull().default(true),
  botEveryoneSpam: boolean("botEveryoneSpam").notNull().default(true),
  detectorThresholds: jsonb("detectorThresholds").notNull().default({}),
  snapshotEnabled: boolean("snapshotEnabled").notNull().default(true),
  riskWeights: jsonb("riskWeights").notNull().default({}),
  thresholds: jsonb("thresholds").notNull().default({}),
  snapshotRetentionCount: integer("snapshotRetentionCount").notNull().default(7),
  snapshotRetentionDays: integer("snapshotRetentionDays").notNull().default(30),
  incidentRetentionDays: integer("incidentRetentionDays").notNull().default(90),
  protectionStatus: text("protectionStatus").notNull().default("Disabled"),
  statusReason: text("statusReason"),
  missingPermissions: jsonb("missingPermissions").notNull().default([]),
  lastDiagnosticAt: timestamp("lastDiagnosticAt", { withTimezone: true }),
  lastIncidentAt: timestamp("lastIncidentAt", { withTimezone: true }),
  updatedBy: text("updatedBy"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
});

export const securityTrustedActor = pgTable("security_trusted_actor", {
  guildId: text("guildId").notNull(),
  actorId: text("actorId").notNull(),
  label: text("label"),
  actorType: text("actorType").notNull().default("unknown"),
  trustedBy: text("trustedBy").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("security_trusted_actor_guild_actor_unique").on(table.guildId, table.actorId),
]);

export const securityIncident = pgTable("security_incident", {
  id: text("id").primaryKey(),
  guildId: text("guildId").notNull(),
  actorId: text("actorId"),
  actorType: text("actorType").notNull().default("unknown"),
  actorName: text("actorName"),
  incidentType: text("incidentType"),
  severity: text("severity").notNull().default("Normal"),
  riskScore: integer("riskScore").notNull().default(0),
  riskExplanation: jsonb("riskExplanation").notNull().default({}),
  actionTaken: jsonb("actionTaken").notNull().default({}),
  status: text("status").notNull().default("Open"),
  firstDetectedAt: timestamp("firstDetectedAt", { withTimezone: true }).notNull(),
  lastDetectedAt: timestamp("lastDetectedAt", { withTimezone: true }).notNull(),
  actionCount: integer("actionCount").notNull().default(0),
  trustedActor: boolean("trustedActor").notNull().default(false),
  guildOwner: boolean("guildOwner").notNull().default(false),
  selfActor: boolean("selfActor").notNull().default(false),
  containmentStatus: text("containmentStatus").notNull().default("not_requested"),
  resolution: text("resolution"),
  resolutionReason: text("resolutionReason"),
  alertMessageId: text("alertMessageId"),
  lastAlertedSeverity: text("lastAlertedSeverity"),
  lastAlertedAt: timestamp("lastAlertedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("security_incident_guild_status_detected_idx").on(table.guildId, table.status, table.lastDetectedAt),
  index("security_incident_guild_actor_detected_idx").on(table.guildId, table.actorId, table.lastDetectedAt),
  index("security_incident_guild_type_detected_idx").on(table.guildId, table.incidentType, table.lastDetectedAt),
]);

export const securityIncidentAction = pgTable("security_incident_action", {
  id: serial("id").primaryKey(),
  incidentId: text("incidentId").notNull(),
  guildId: text("guildId").notNull(),
  auditLogEntryId: text("auditLogEntryId").notNull(),
  actionType: text("actionType").notNull(),
  actorId: text("actorId"),
  targetId: text("targetId"),
  occurredAt: timestamp("occurredAt", { withTimezone: true }).notNull(),
  riskWeight: integer("riskWeight").notNull().default(0),
  destructive: boolean("destructive").notNull().default(false),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("security_incident_action_audit_entry_unique").on(table.auditLogEntryId),
  index("security_incident_action_incident_occurred_idx").on(table.incidentId, table.occurredAt),
  index("security_incident_action_guild_actor_occurred_idx").on(table.guildId, table.actorId, table.occurredAt),
]);

export const securitySnapshot = pgTable("security_snapshot", {
  id: text("id").primaryKey(),
  guildId: text("guildId").notNull(),
  source: text("source").notNull().default("manual"),
  schemaVersion: integer("schemaVersion").notNull().default(1),
  checksum: text("checksum").notNull(),
  data: jsonb("data").notNull(),
  createdBy: text("createdBy"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("security_snapshot_guild_created_idx").on(table.guildId, table.createdAt),
]);

export const securityAuditEvent = pgTable("security_audit_event", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  incidentId: text("incidentId"),
  eventType: text("eventType").notNull(),
  actorId: text("actorId"),
  actorName: text("actorName"),
  source: text("source").notNull().default("bot"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("security_audit_event_guild_created_idx").on(table.guildId, table.createdAt),
  index("security_audit_event_incident_created_idx").on(table.incidentId, table.createdAt),
]);

// Vercel cannot directly mutate Discord. Authorized requests are claimed by
// the connected Bot and completed with a bounded result document.
export const securityActionRequest = pgTable("security_action_request", {
  id: text("id").primaryKey(),
  guildId: text("guildId").notNull(),
  incidentId: text("incidentId"),
  action: text("action").notNull(),
  requestedBy: text("requestedBy").notNull(),
  requestedByName: text("requestedByName"),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("queued"),
  result: jsonb("result"),
  errorCode: text("errorCode"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimedAt", { withTimezone: true }),
  completedAt: timestamp("completedAt", { withTimezone: true }),
}, (table) => [
  index("security_action_request_status_created_idx").on(table.status, table.createdAt),
  index("security_action_request_guild_created_idx").on(table.guildId, table.createdAt),
]);
