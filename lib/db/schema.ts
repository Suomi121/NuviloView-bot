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
