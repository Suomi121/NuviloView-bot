import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  date,
  serial,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// --- Better Auth required tables -------------------------------------------
// Column names are camelCase to match Better Auth's defaults. Do not rename.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
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
  channelName: text("channelName").notNull(),
  authorId: text("authorId").notNull(),
  authorName: text("authorName").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A session starts when a non-bot member joins a voice channel and ends when
// they leave voice altogether. Moving between voice channels is continuous.
export const voiceSession = pgTable("voice_session", {
  id: serial("id").primaryKey(),
  guildId: text("guildId").notNull(),
  userId: text("userId").notNull(),
  channelId: text("channelId").notNull(),
  startedAt: timestamp("startedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("endedAt", { withTimezone: true }),
});

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

// An opt-in, privacy-safe public snapshot. It never includes message bodies,
// member identities, or operational information.
export const guildPublicReport = pgTable("guild_public_report", {
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  guildId: text("guildId").notNull(),
  slug: text("slug").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description").notNull().default(""),
  showMembers: boolean("showMembers").notNull().default(true),
  showMessages: boolean("showMessages").notNull().default(true),
  showVoice: boolean("showVoice").notNull().default(true),
  showChannels: boolean("showChannels").notNull().default(true),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("guild_public_report_user_guild_unique").on(table.userId, table.guildId),
  uniqueIndex("guild_public_report_slug_unique").on(table.slug),
]);

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
  status: text("status").notNull().default("queued"),
  processedMessages: integer("processedMessages").notNull().default(0),
  failedChannels: integer("failedChannels").notNull().default(0),
  requestedAt: timestamp("requestedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("startedAt", { withTimezone: true }),
  completedAt: timestamp("completedAt", { withTimezone: true }),
  error: text("error"),
});
