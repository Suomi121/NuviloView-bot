import {
  ActionRowBuilder,
  ActivityType,
  ApplicationCommandType,
  Client,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { neon } from "@neondatabase/serverless";
import { createHmac } from "node:crypto";

if (!process.env.DATABASE_URL || !process.env.DISCORD_BOT_TOKEN) {
  throw new Error(
    "DATABASE_URL and DISCORD_BOT_TOKEN must be set before starting the bot.",
  );
}

const sql = neon(process.env.DATABASE_URL);
const messageRetentionDays = Number.isInteger(
  Number(process.env.MESSAGE_RETENTION_DAYS),
)
  ? Math.min(Math.max(Number(process.env.MESSAGE_RETENTION_DAYS), 7), 365)
  : 90;
const libreTranslateUrl = (process.env.LIBRETRANSLATE_URL?.trim() || "http://127.0.0.1:5000").replace(/\/+$/, "");
const libreTranslateVersion = process.env.LIBRETRANSLATE_VERSION?.trim() || "1.9.6";
const translationMonthlyLimit = 600_000;
const translationRequestWindowMs = 60 * 1000;
const translationRequestLimit = 8;
const translationRequestLifetimeMs = 5 * 60 * 1000;
const botStartedAt = new Date();
const botHeartbeatId = "primary";
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const dashboardUrl = "https://nuviloview-oem.vercel.app/";
const applicationId = process.env.DISCORD_CLIENT_ID;
const developerGuildId = process.env.DISCORD_DEV_GUILD_ID;
const developerOwnerUserId = process.env.DISCORD_OWNER_USER_ID?.trim() || null;
const auditSigningKey = process.env.AUDIT_LOG_SIGNING_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim() || null;
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL?.trim() || null;
const alertCooldownMs = 5 * 60 * 1000;
const sentAlerts = new Map();
const commandSyncCooldownMs = 60 * 1000;
const guildCommandSyncCooldownMs = 5 * 60 * 1000;
const commandSyncAttempts = new Map();
const botServersAttempts = new Map();
const guildCommandSyncAttempts = new Map();
const blockedGuildIds = new Set();
const translationAttempts = new Map();
const translationRequests = new Map();
const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("NuviloChan Botで使えるコマンドを表示します")
  .toJSON();
const statusCheckCommand = new SlashCommandBuilder()
  .setName("stc")
  .setDescription("Botの接続・データ記録状況をすばやく確認します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const todayActiveCommand = new SlashCommandBuilder()
  .setName("tactive")
  .setDescription("このサーバーの今日の活動を表示します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const permissionsCommand = new SlashCommandBuilder()
  .setName("permissions")
  .setDescription("Botが読み取れないチャンネルと不足している権限を確認します")
  .addIntegerOption((option) =>
    option
      .setName("page")
      .setDescription("表示するページ番号")
      .setMinValue(1),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const setupCommand = new SlashCommandBuilder()
  .setName("suc")
  .setDescription("初期設定とチャンネル権限を確認します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const weekCommand = new SlashCommandBuilder()
  .setName("week")
  .setDescription("このサーバーの直近7日間の活動を表示します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const dashboardCommand = new SlashCommandBuilder()
  .setName("dashboard")
  .setDescription("NuviloViewダッシュボードを開くリンクを表示します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const privacyCommand = new SlashCommandBuilder()
  .setName("privacy")
  .setDescription("NuviloChan Botが保存するデータと保持期間を表示します")
  .toJSON();
const translateMessageCommand = new ContextMenuCommandBuilder()
  .setName("NuviloChan 翻訳")
  .setType(ApplicationCommandType.Message)
  .toJSON();
const serverCommandUpdateCommand = new SlashCommandBuilder()
  .setName("commandupdate")
  .setDescription("このサーバーのBotコマンドを即時更新します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();
const commandUpdateCommand = new SlashCommandBuilder()
  .setName("cmup")
  .setDescription("開発用サーバーのコマンド定義を即時更新します")
  .toJSON();
const botServersCommand = new SlashCommandBuilder()
  .setName("botservers")
  .setDescription("開発者用: Botが導入されているサーバー一覧を表示します")
  .addIntegerOption((option) =>
    option
      .setName("page")
      .setDescription("表示するページ番号")
      .setMinValue(1),
  )
  .toJSON();
const diagnosticsCommand = new SlashCommandBuilder()
  .setName("diagnostics")
  .setDescription("開発者用: Bot接続・記録・権限状態を診断します")
  .toJSON();
const guildBlockCommand = new SlashCommandBuilder()
  .setName("guildblock")
  .setDescription("開発者用: 指定サーバーでのBotを停止して退出します")
  .addStringOption((option) =>
    option
      .setName("server_id")
      .setDescription("停止するサーバーID")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("停止理由（監査記録用）")
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(300),
  )
  .toJSON();
const guildUnblockCommand = new SlashCommandBuilder()
  .setName("guildunblock")
  .setDescription("開発者用: 指定サーバーへのBot再導入を許可します")
  .addStringOption((option) =>
    option
      .setName("server_id")
      .setDescription("解除するサーバーID")
      .setRequired(true),
  )
  .toJSON();
const guildBlocksCommand = new SlashCommandBuilder()
  .setName("guildblocks")
  .setDescription("開発者用: Botを停止しているサーバー一覧を表示します")
  .toJSON();
// Keep the public surface intentionally small. Detailed administration is
// available in the dashboard; the developer guild receives the extended set.
const publicCommands = [
  helpCommand,
  todayActiveCommand,
  serverCommandUpdateCommand,
];
// These are registered per guild so newly-added management tools can appear
// immediately without duplicating the small global command set.
const extendedCommands = [
  permissionsCommand,
  setupCommand,
  weekCommand,
  dashboardCommand,
  privacyCommand,
  translateMessageCommand,
];
const developerCommands = [
  commandUpdateCommand,
  botServersCommand,
  diagnosticsCommand,
  guildBlockCommand,
  guildUnblockCommand,
  guildBlocksCommand,
];

function getRestClient() {
  return new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
}

function safeErrorText(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replaceAll(process.env.DISCORD_BOT_TOKEN ?? "", "[REDACTED]")
    .replace(/(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})/g, "[REDACTED]")
    .slice(0, 1_500);
}

async function reportOperationalAlert(title, error) {
  if (!alertWebhookUrl || !/^https:\/\/discord(?:app)?\.com\/api\/webhooks\//.test(alertWebhookUrl)) return;
  const key = `${title}:${safeErrorText(error).slice(0, 120)}`;
  const previous = sentAlerts.get(key) ?? 0;
  if (Date.now() - previous < alertCooldownMs) return;
  sentAlerts.set(key, Date.now());
  try {
    await fetch(alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "NuviloChan Monitor", embeds: [{ title: `⚠️ ${title}`, description: `\`${safeErrorText(error)}\``, color: 0xed4245, timestamp: new Date().toISOString() }] }),
    });
  } catch { /* Alerts must never stop the Bot. */ }
}

function getGuildCommandDefinitions(guildId) {
  // Do not repeat the global core commands here: Discord would show them
  // twice. The extended commands are guild-scoped for immediate availability.
  return guildId === developerGuildId
    ? [...extendedCommands, ...developerCommands]
    : extendedCommands;
}

async function syncGuildCommands(guildId) {
  if (!applicationId)
    throw new Error(
      "DISCORD_CLIENT_ID must be set before registering slash commands.",
    );
  await getRestClient().put(
    Routes.applicationGuildCommands(applicationId, guildId),
    { body: getGuildCommandDefinitions(guildId) },
  );
}

async function registerCommands() {
  if (!applicationId)
    throw new Error(
      "DISCORD_CLIENT_ID must be set before registering slash commands.",
    );
  const rest = getRestClient();
  await rest.put(Routes.applicationCommands(applicationId), {
    body: publicCommands,
  });
  if (developerGuildId) {
    await syncGuildCommands(developerGuildId);
    console.log(`Developer commands synced to guild ${developerGuildId}`);
  }
}

function canUseBotServers(interaction) {
  return Boolean(
    developerOwnerUserId &&
      developerGuildId &&
      interaction.guildId === developerGuildId &&
      interaction.user.id === developerOwnerUserId,
  );
}

function formatGuildName(name) {
  return name
    .replace(/[\\`*_~|]/g, "\\$&")
    .replace(/@/g, "＠")
    .slice(0, 80);
}

const translationLanguages = [
  ["🇯🇵", "日本語", "ja"],
  ["🇺🇸", "English", "en"],
  ["🇨🇳", "简体中文", "zh-Hans"],
  ["🇹🇼", "繁體中文", "zh-Hant"],
  ["🇰🇷", "한국어", "ko"],
  ["🇪🇸", "Español", "es"],
  ["🇫🇷", "Français", "fr"],
  ["🇩🇪", "Deutsch", "de"],
  ["🇮🇹", "Italiano", "it"],
  ["🇵🇹", "Português", "pt"],
  ["🇷🇺", "Русский", "ru"],
  ["🇺🇦", "Українська", "uk"],
  ["🇸🇦", "العربية", "ar"],
  ["🇮🇳", "हिन्दी", "hi"],
  ["🇮🇩", "Bahasa Indonesia", "id"],
  ["🇻🇳", "Tiếng Việt", "vi"],
  ["🇹🇭", "ไทย", "th"],
  ["🇹🇷", "Türkçe", "tr"],
  ["🇵🇱", "Polski", "pl"],
  ["🇳🇱", "Nederlands", "nl"],
  ["🇸🇪", "Svenska", "sv"],
  ["🇫🇮", "Suomi", "fi"],
  ["🇬🇷", "Ελληνικά", "el"],
];

async function getLibreTranslateLanguages() {
  const response = await fetch(`${libreTranslateUrl}/languages`, {
    signal: AbortSignal.timeout(3_000),
  });
  const languages = await response.json();
  if (!response.ok || !Array.isArray(languages)) {
    throw new Error("Local translation service is unavailable.");
  }
  return languages
    .filter((language) => typeof language?.code === "string")
    .map((language) => ({
      code: language.code,
      name: typeof language.name === "string" ? language.name : language.code,
    }));
}

function createTranslationRequest(userId, content, supportedLanguages) {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  translationRequests.set(id, {
    userId,
    content,
    supportedLanguages,
    expiresAt: Date.now() + translationRequestLifetimeMs,
  });
  return id;
}

function getTranslationRequest(id, userId) {
  const request = translationRequests.get(id);
  if (!request || request.userId !== userId || request.expiresAt < Date.now()) {
    translationRequests.delete(id);
    return null;
  }
  return request;
}

function decodeTranslatedText(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function detectTranslationSource(content) {
  if (/[\u3040-\u30ff]/u.test(content)) return "ja";
  if (/\p{Script=Hangul}/u.test(content)) return "ko";
  if (/\p{Script=Thai}/u.test(content)) return "th";
  if (/\p{Script=Arabic}/u.test(content)) return "ar";
  if (/\p{Script=Hebrew}/u.test(content)) return "he";
  if (/\p{Script=Devanagari}/u.test(content)) return "hi";
  if (/\p{Script=Han}/u.test(content)) return "zh-Hans";
  return "auto";
}

function translationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function consumeTranslationRateLimit(userId) {
  const now = Date.now();
  const attempts = (translationAttempts.get(userId) ?? []).filter(
    (attempt) => now - attempt < translationRequestWindowMs,
  );
  if (attempts.length >= translationRequestLimit) {
    throw translationError(
      "RATE_LIMIT",
      "翻訳は1分あたり8回までです。少し待ってからお試しください。",
    );
  }
  attempts.push(now);
  translationAttempts.set(userId, attempts);
}

async function reserveTranslationCharacters(characterCount) {
  const rows = await sql`
    INSERT INTO "translation_usage" ("month", "characterCount")
    VALUES (date_trunc('month', CURRENT_DATE)::date, ${characterCount})
    ON CONFLICT ("month")
    DO UPDATE SET
      "characterCount" = "translation_usage"."characterCount" + EXCLUDED."characterCount",
      "updatedAt" = now()
    WHERE "translation_usage"."characterCount" + EXCLUDED."characterCount" <= ${translationMonthlyLimit}
    RETURNING "characterCount"
  `;
  return rows[0] ? Number(rows[0].characterCount) : null;
}

async function releaseTranslationCharacters(characterCount) {
  await sql`
    UPDATE "translation_usage"
    SET "characterCount" = GREATEST(0, "characterCount" - ${characterCount}), "updatedAt" = now()
    WHERE "month" = date_trunc('month', CURRENT_DATE)::date
  `;
}

async function translateMessageText({ content, targetLanguage, userId }) {
  if (!content.trim()) {
    throw translationError("EMPTY_MESSAGE", "テキストを含むメッセージだけ翻訳できます。");
  }
  consumeTranslationRateLimit(userId);
  const characterCount = [...content].length;
  const usedCharacters = await reserveTranslationCharacters(characterCount);
  if (usedCharacters === null) {
    throw translationError(
      "MONTHLY_LIMIT",
      "今月の翻訳処理枠（60万文字）を使い切りました。翌月に自動で再開します。",
    );
  }
  try {
    const response = await fetch(
      `${libreTranslateUrl}/translate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: content,
          source: detectTranslationSource(content),
          target: targetLanguage,
          format: "text",
        }),
      },
    );
    const body = await response.json();
    if (!response.ok || !body?.translatedText) {
      throw new Error(body?.error?.message ?? "Translation API request failed.");
    }
    return {
      text: decodeTranslatedText(body.translatedText),
      detectedLanguage: body.detectedLanguage?.language ?? null,
      remainingCharacters: translationMonthlyLimit - usedCharacters,
    };
  } catch (error) {
    await releaseTranslationCharacters(characterCount);
    throw error;
  }
}

function getLanguageLabel(languageCode) {
  const language = translationLanguages.find(([, , code]) => code === languageCode);
  return language ? `${language[0]} ${language[1]}` : languageCode;
}

function getLanguageEmoji(languageCode) {
  return translationLanguages.find(([, , code]) => code === languageCode)?.[0] ?? "🌐";
}

function createTranslationLanguagePicker(requestId, availableLanguages, page = 0) {
  const priorityCodes = translationLanguages.map(([, , code]) => code);
  const prioritized = [...availableLanguages]
    .sort((left, right) => {
      const leftPriority = priorityCodes.indexOf(left.code);
      const rightPriority = priorityCodes.indexOf(right.code);
      if (leftPriority !== -1 || rightPriority !== -1) {
        return (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority);
      }
      return left.name.localeCompare(right.name, "en");
    });
  const primary = prioritized.filter((language) => priorityCodes.includes(language.code));
  const otherLanguages = prioritized.filter((language) => !priorityCodes.includes(language.code));
  const toOption = (language) => ({
    label: language.name.slice(0, 100),
    value: language.code,
    description: language.code,
    emoji: getLanguageEmoji(language.code),
  });

  let options;
  if (page === 0) {
    options = primary.slice(0, 24).map(toOption);
    if (otherLanguages.length > 0 || primary.length > 24) {
      options.push({
        label: "その他の言語を表示",
        value: "__nvpage:1",
        description: "追加の対応言語から選択",
        emoji: "🌐",
      });
    }
  } else {
    const selectableLanguages = [...primary.slice(24), ...otherLanguages];
    const pageSize = 23;
    const start = (page - 1) * pageSize;
    options = selectableLanguages.slice(start, start + pageSize).map(toOption);
    if (page > 1) {
      options.unshift({
        label: "← よく使う言語に戻る",
        value: "__nvpage:0",
        description: "最初の一覧へ戻る",
        emoji: "↩️",
      });
    }
    if (start + pageSize < selectableLanguages.length) {
      options.push({
        label: "さらに言語を表示 →",
        value: `__nvpage:${page + 1}`,
        description: "次の言語一覧へ",
        emoji: "➡️",
      });
    }
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`nvtranslate:${requestId}:${page}`)
        .setPlaceholder("翻訳先の言語を選択")
        .addOptions(options),
    ),
  ];
}

function isGuildBlocked(guildId) {
  return blockedGuildIds.has(guildId);
}

async function loadBlockedGuilds() {
  const rows = await sql`SELECT "guildId" FROM "bot_guild_blocklist"`;
  blockedGuildIds.clear();
  for (const row of rows) blockedGuildIds.add(row.guildId);
}

async function recordBlockAudit({ guildId, action, reason = null, performedBy, performedByName = null, source = "bot_command" }) {
  if (!auditSigningKey) throw new Error("AUDIT_LOG_SIGNING_SECRET (or BETTER_AUTH_SECRET) must be set for signed audit logs.");
  const previous = await sql`SELECT "entryHash" FROM "bot_guild_block_audit" WHERE "entryHash" IS NOT NULL ORDER BY "id" DESC LIMIT 1`;
  const previousHash = previous[0]?.entryHash ?? "GENESIS";
  const createdAt = new Date().toISOString();
  const entryHash = createHmac("sha256", auditSigningKey).update([
    "nuviloview-audit-v1", previousHash, guildId, action, reason ?? "", performedBy, performedByName ?? "", source, createdAt,
  ].join("\n")).digest("hex");
  await sql`
    INSERT INTO "bot_guild_block_audit" ("guildId", "action", "reason", "performedBy", "performedByName", "source", "createdAt", "previousHash", "entryHash")
    VALUES (${guildId}, ${action}, ${reason}, ${performedBy}, ${performedByName}, ${source}, ${createdAt}, ${previousHash}, ${entryHash})
  `;
}

async function syncGuildRegistry(guild) {
  if (isGuildBlocked(guild.id)) {
    await markGuildDisconnected(guild.id);
    return;
  }
  const iconUrl = guild.iconURL({ extension: "png", size: 128 }) ?? null;
  await sql`
    INSERT INTO "bot_guild_registry" ("guildId", "name", "iconUrl", "ownerId", "memberCount", "isConnected", "lastSeenAt", "updatedAt")
    VALUES (${guild.id}, ${guild.name.slice(0, 100)}, ${iconUrl}, ${guild.ownerId ?? null}, ${guild.memberCount}, true, now(), now())
    ON CONFLICT ("guildId") DO UPDATE SET
      "name" = EXCLUDED."name",
      "iconUrl" = EXCLUDED."iconUrl",
      "ownerId" = EXCLUDED."ownerId",
      "memberCount" = EXCLUDED."memberCount",
      "isConnected" = true,
      "lastSeenAt" = now(),
      "updatedAt" = now()
  `;
}

async function markGuildDisconnected(guildId) {
  await sql`
    UPDATE "bot_guild_registry"
    SET "isConnected" = false, "updatedAt" = now()
    WHERE "guildId" = ${guildId}
  `;
}

async function enforceBlockedGuilds() {
  await loadBlockedGuilds();
  await Promise.allSettled(
    client.guilds.cache.map((guild) => leaveBlockedGuild(guild, "blocklist refresh")),
  );
}

async function purgeGuildData(guildId) {
  await Promise.all([
    sql`DELETE FROM "daily_stats" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "daily_active_member" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "recent_activity" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "discord_message" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "voice_session" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "voice_server_session" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "bot_channel_access" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "history_import_job" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "user_notification" WHERE "guildId" = ${guildId}`,
  ]);
}

async function leaveBlockedGuild(guild, source) {
  if (!isGuildBlocked(guild.id)) return false;
  try {
    await guild.leave();
    await markGuildDisconnected(guild.id);
    console.warn(`Left blocked guild ${guild.id} (${source}).`);
  } catch (error) {
    console.error(`Failed to leave blocked guild ${guild.id} (${source}):`, error);
  }
  return true;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}時間${minutes}分`;
  return `${minutes}分`;
}

function formatTimestamp(value) {
  if (!value) return "まだ記録がありません";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

async function getTodayActivity(guildId) {
  const [dailyRows, voiceRows, channelRows] = await Promise.all([
    sql`
      SELECT
        COALESCE((
          SELECT "messageCount" FROM "daily_stats"
          WHERE "guildId" = ${guildId} AND "date" = CURRENT_DATE
          LIMIT 1
        ), 0)::int AS "messageCount",
        COALESCE((
          SELECT COUNT(*) FROM "daily_active_member"
          WHERE "guildId" = ${guildId} AND "date" = CURRENT_DATE
        ), 0)::int AS "activeMemberCount",
        (
          SELECT "updatedAt" FROM "daily_stats"
          WHERE "guildId" = ${guildId}
          ORDER BY "updatedAt" DESC
          LIMIT 1
        ) AS "lastRecordedAt"
    `,
    sql`
      SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
        LEAST(COALESCE("endedAt", now()), now())
        - GREATEST("startedAt", date_trunc('day', now()))
      ))), 0) AS "voiceSeconds"
      FROM "voice_server_session"
      WHERE "guildId" = ${guildId}
        AND "startedAt" < now()
        AND ("endedAt" IS NULL OR "endedAt" > date_trunc('day', now()))
    `,
    sql`
      SELECT "channelName", COUNT(*)::int AS "messageCount"
      FROM "discord_message"
      WHERE "guildId" = ${guildId} AND "createdAt" >= CURRENT_DATE
      GROUP BY "channelName"
      ORDER BY "messageCount" DESC, "channelName" ASC
      LIMIT 1
    `,
  ]);

  return {
    messageCount: Number(dailyRows[0]?.messageCount ?? 0),
    activeMemberCount: Number(dailyRows[0]?.activeMemberCount ?? 0),
    lastRecordedAt: dailyRows[0]?.lastRecordedAt ?? null,
    voiceSeconds: Number(voiceRows[0]?.voiceSeconds ?? 0),
    topChannel: channelRows[0]
      ? {
          name: channelRows[0].channelName,
          messageCount: Number(channelRows[0].messageCount ?? 0),
        }
      : null,
  };
}

async function getChannelAccessStatus(guildId) {
  const rows = await sql`
    SELECT
      MAX("checkedAt") AS "lastCheckedAt",
      COUNT(*)::int AS "channelCount",
      COUNT(*) FILTER (WHERE "canRead" = false)::int AS "unreadableChannelCount",
      COALESCE(
        ARRAY_AGG("channelName" ORDER BY "channelName") FILTER (WHERE "canRead" = false),
        ARRAY[]::text[]
      ) AS "unreadableChannelNames"
    FROM "bot_channel_access"
    WHERE "guildId" = ${guildId}
  `;
  const status = rows[0] ?? {};
  return {
    lastCheckedAt: status.lastCheckedAt ?? null,
    channelCount: Number(status.channelCount ?? 0),
    unreadableChannelCount: Number(status.unreadableChannelCount ?? 0),
    unreadableChannelNames: Array.isArray(status.unreadableChannelNames)
      ? status.unreadableChannelNames
      : [],
  };
}

async function getWeekActivity(guildId) {
  const [summaryRows, activeRows, voiceRows, channelRows] = await Promise.all([
    sql`
      SELECT
        COALESCE(SUM("messageCount"), 0)::int AS "messageCount",
        COALESCE(SUM("reactionCount"), 0)::int AS "reactionCount"
      FROM "daily_stats"
      WHERE "guildId" = ${guildId} AND "date" >= CURRENT_DATE - 6
    `,
    sql`
      SELECT COUNT(DISTINCT "userId")::int AS "activeMemberCount"
      FROM "daily_active_member"
      WHERE "guildId" = ${guildId} AND "date" >= CURRENT_DATE - 6
    `,
    sql`
      WITH selected_sessions AS (
        SELECT
          GREATEST("startedAt", now() - interval '7 days') AS "startedAt",
          LEAST(COALESCE("endedAt", now()), now()) AS "endedAt"
        FROM "voice_server_session"
        WHERE "guildId" = ${guildId}
          AND "startedAt" < now()
          AND ("endedAt" IS NULL OR "endedAt" > now() - interval '7 days')
      )
      SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))), 0) AS "voiceSeconds"
      FROM selected_sessions
    `,
    sql`
      SELECT "channelName", COUNT(*)::int AS "messageCount"
      FROM "discord_message"
      WHERE "guildId" = ${guildId} AND "createdAt" >= CURRENT_DATE - 6
      GROUP BY "channelName"
      ORDER BY "messageCount" DESC, "channelName" ASC
      LIMIT 1
    `,
  ]);
  const summary = summaryRows[0] ?? {};
  const messageCount = Number(summary.messageCount ?? 0);
  const reactionCount = Number(summary.reactionCount ?? 0);
  return {
    messageCount,
    activeMemberCount: Number(activeRows[0]?.activeMemberCount ?? 0),
    voiceSeconds: Number(voiceRows[0]?.voiceSeconds ?? 0),
    reactionRate:
      messageCount > 0 ? Math.round((reactionCount / messageCount) * 1000) / 10 : 0,
    topChannel: channelRows[0]
      ? {
          name: channelRows[0].channelName,
          messageCount: Number(channelRows[0].messageCount ?? 0),
        }
      : null,
  };
}

async function requireGuildManager(interaction) {
  if (
    interaction.inGuild() &&
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }
  await interaction.reply({
    content: "このコマンドはサーバー管理権限を持つメンバーのみ実行できます。",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

async function updateMemberCount(guild) {
  if (isGuildBlocked(guild.id)) return;
  await sql`
    INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "date")
    VALUES (${guild.id}, ${guild.memberCount}, 0, CURRENT_DATE)
    ON CONFLICT ("guildId", "date")
    DO UPDATE SET "memberCount" = EXCLUDED."memberCount", "updatedAt" = now()
  `;
}

// This is deliberately independent from analytics writes. An external monitor
// treats the Bot as unavailable when this record is no longer refreshed.
async function recordBotHeartbeat() {
  if (!client.isReady()) return;
  await sql`
    INSERT INTO "bot_heartbeat" ("id", "lastSeenAt", "startedAt", "guildCount", "stoppedAt")
    VALUES (${botHeartbeatId}, now(), ${botStartedAt}, ${client.guilds.cache.size}, NULL)
    ON CONFLICT ("id") DO UPDATE SET
      "lastSeenAt" = now(),
      "startedAt" = EXCLUDED."startedAt",
      "guildCount" = EXCLUDED."guildCount",
      "stoppedAt" = NULL
  `;
  await Promise.allSettled(client.guilds.cache.map(syncGuildRegistry));
}

async function syncChannelAccess(guild) {
  if (isGuildBlocked(guild.id)) return;
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const channels = await guild.channels.fetch();
  const channelAccess = [...channels.values()]
    .filter((channel) => channel?.isTextBased?.() && "messages" in channel)
    .map((channel) => {
      const permissions = channel.permissionsFor(botMember);
      return {
        channelId: channel.id,
        channelName: "name" in channel ? channel.name : "不明なチャンネル",
        canRead: Boolean(
          permissions?.has(PermissionFlagsBits.ViewChannel) &&
            permissions?.has(PermissionFlagsBits.ReadMessageHistory),
        ),
      };
    });
  const snapshot = JSON.stringify(channelAccess);

  await sql`
    INSERT INTO "bot_channel_access" ("guildId", "channelId", "channelName", "canRead", "checkedAt")
    SELECT ${guild.id}, channel."channelId", channel."channelName", channel."canRead", now()
    FROM jsonb_to_recordset(${snapshot}::jsonb)
      AS channel("channelId" text, "channelName" text, "canRead" boolean)
    ON CONFLICT ("guildId", "channelId")
    DO UPDATE SET
      "channelName" = EXCLUDED."channelName",
      "canRead" = EXCLUDED."canRead",
      "checkedAt" = EXCLUDED."checkedAt"
  `;
  await sql`
    DELETE FROM "bot_channel_access" AS access
    WHERE access."guildId" = ${guild.id}
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${JSON.stringify(channelAccess.map((channel) => channel.channelId))}::jsonb) AS current("channelId")
        WHERE current."channelId" = access."channelId"
      )
  `;
}

async function recordActivity({
  guildId,
  type,
  actorName,
  channelName = null,
}) {
  if (isGuildBlocked(guildId)) return;
  await sql`
    INSERT INTO "recent_activity" ("guildId", "type", "actorName", "channelName")
    VALUES (${guildId}, ${type}, ${actorName}, ${channelName})
  `;
}

async function recordActiveMember({ guildId, userId }) {
  if (isGuildBlocked(guildId)) return;
  await sql`
    INSERT INTO "daily_active_member" ("guildId", "userId", "date")
    VALUES (${guildId}, ${userId}, CURRENT_DATE)
    ON CONFLICT ("guildId", "userId", "date") DO NOTHING
  `;
}

// When the bot is restarted mid-day, Discord does not replay old messageCreate
// events. Read the recent channel history once so today's active-member count
// starts with people who have already spoken today.
async function restoreTodayActiveMembers(guild) {
  if (isGuildBlocked(guild.id)) return;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const channels = await guild.channels.fetch();
  const textChannels = [...channels.values()].filter(
    (channel) => channel?.isTextBased?.() && "messages" in channel,
  );

  await Promise.allSettled(
    textChannels.map(async (channel) => {
      const messages = await channel.messages.fetch({ limit: 100 });
      const activeUserIds = new Set(
        messages
          .filter(
            (message) =>
              !message.author.bot && message.createdAt >= startOfToday,
          )
          .map((message) => message.author.id),
      );
      await Promise.all(
        [...activeUserIds].map((userId) =>
          recordActiveMember({ guildId: guild.id, userId }),
        ),
      );
    }),
  );
}

async function storeMessage(message) {
  if (
    !message.guild ||
    isGuildBlocked(message.guild.id) ||
    message.author.bot ||
    !message.content.trim()
  )
    return;
  const channelName =
    "name" in message.channel ? message.channel.name : "不明なチャンネル";
  await sql`
    INSERT INTO "discord_message" ("id", "guildId", "channelName", "authorId", "authorName", "content", "createdAt", "updatedAt")
    VALUES (${message.id}, ${message.guild.id}, ${channelName}, ${message.author.id}, ${message.member?.displayName ?? message.author.username}, ${message.content}, ${message.createdAt}, now())
    ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content", "updatedAt" = now()
  `;
}

async function purgeExpiredMessages() {
  await sql`DELETE FROM "discord_message" WHERE "createdAt" < now() - (${messageRetentionDays} * interval '1 day')`;
}

const historyImportDelayMs = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateHistoryImportJob(id, fields) {
  await sql`
    UPDATE "history_import_job"
    SET "processedMessages" = ${fields.processedMessages}, "failedChannels" = ${fields.failedChannels}
    WHERE "id" = ${id}
  `;
}

async function claimHistoryImportJob() {
  const jobs = await sql`
    WITH candidate AS (
      SELECT "id"
      FROM "history_import_job"
      WHERE "status" = 'queued'
      ORDER BY "requestedAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "history_import_job" AS job
    SET "status" = 'running', "startedAt" = now(), "error" = NULL
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job."id", job."guildId", job."days", job."mode"
  `;
  return jobs[0] ?? null;
}

// Discord only exposes historical messages per channel. Voice-state events are
// deliberately not reconstructed here: they are accurate only from Bot uptime.
async function processHistoryImportJob(job) {
  let processedMessages = 0;
  let failedChannels = 0;
  try {
    if (isGuildBlocked(job.guildId)) {
      await sql`DELETE FROM "history_import_job" WHERE "id" = ${job.id}`;
      return;
    }
    const guild =
      client.guilds.cache.get(job.guildId) ??
      (await client.guilds.fetch(job.guildId));
    if (!guild) throw new Error("Bot is not available in this server.");
    const cutoff = new Date(Date.now() - job.days * 24 * 60 * 60 * 1000);
    const channels = await guild.channels.fetch();
    const textChannels = [...channels.values()].filter(
      (channel) => channel?.isTextBased?.() && "messages" in channel,
    );

    const workerCount =
      job.mode === "developer" ? Math.min(3, textChannels.length) : 1;
    let nextChannelIndex = 0;
    const importChannel = async (channel) => {
      try {
        let before;
        let reachedCutoff = false;
        while (!reachedCutoff) {
          if (isGuildBlocked(job.guildId)) return;
          const messages = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {}),
          });
          if (messages.size === 0) break;
          for (const message of messages.values()) {
            if (message.createdAt < cutoff) {
              reachedCutoff = true;
              break;
            }
            if (!message.author.bot && message.content.trim()) {
              await storeMessage(message);
              processedMessages += 1;
            }
          }
          before = messages.last()?.id;
          await updateHistoryImportJob(job.id, {
            processedMessages,
            failedChannels,
          });
          if (!before || messages.size < 100) break;
          await delay(historyImportDelayMs);
        }
      } catch (error) {
        failedChannels += 1;
        console.warn(
          `History import skipped channel ${channel?.id ?? "unknown"}:`,
          error.message,
        );
        await updateHistoryImportJob(job.id, {
          processedMessages,
          failedChannels,
        });
      }
    };
    const worker = async () => {
      while (nextChannelIndex < textChannels.length) {
        const channel = textChannels[nextChannelIndex];
        nextChannelIndex += 1;
        await importChannel(channel);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await sql`
      UPDATE "history_import_job"
      SET "status" = 'completed', "processedMessages" = ${processedMessages}, "failedChannels" = ${failedChannels}, "completedAt" = now()
      WHERE "id" = ${job.id}
    `;
  } catch (error) {
    console.error("History import failed:", error);
    await sql`
      UPDATE "history_import_job"
      SET "status" = 'failed', "processedMessages" = ${processedMessages}, "failedChannels" = ${failedChannels}, "completedAt" = now(), "error" = ${String(error.message ?? "Unknown error").slice(0, 500)}
      WHERE "id" = ${job.id}
    `;
  }
}

async function pollHistoryImportJobs() {
  const job = await claimHistoryImportJob();
  if (job) await processHistoryImportJob(job);
}

function hasHumanVoiceActivity(guild) {
  return [...guild.voiceStates.cache.values()].some(
    (state) => state.channelId && state.member?.user.bot !== true,
  );
}

// A server session advances only once while at least one human is connected to
// any voice channel. Moving channels or adding members does not split it.
async function syncServerVoiceSession(guild) {
  if (isGuildBlocked(guild.id)) return;
  if (hasHumanVoiceActivity(guild)) {
    await sql`
      INSERT INTO "voice_server_session" ("guildId")
      VALUES (${guild.id})
      ON CONFLICT ("guildId") WHERE "endedAt" IS NULL DO NOTHING
    `;
  } else {
    await sql`
      UPDATE "voice_server_session"
      SET "endedAt" = now()
      WHERE "guildId" = ${guild.id} AND "endedAt" IS NULL
    `;
  }
}

client.once("clientReady", async () => {
  client.user.setActivity("NuviloView", { type: ActivityType.Playing });
  console.log(`NuviloView:OEM bot logged in as ${client.user.tag}`);
  try {
    await recordBotHeartbeat();
    await loadBlockedGuilds();
    await registerCommands();
    // Remove legacy per-guild registrations left by earlier releases. The
    // global core commands remain available without appearing twice.
    await Promise.allSettled(
      client.guilds.cache
        .filter((guild) => guild.id !== developerGuildId)
        .map((guild) => syncGuildCommands(guild.id)),
    );
    await Promise.allSettled(
      client.guilds.cache.map((guild) => leaveBlockedGuild(guild, "startup")),
    );
    await Promise.allSettled(client.guilds.cache.map(syncGuildRegistry));
    await Promise.all(client.guilds.cache.map(updateMemberCount));
    await Promise.allSettled(
      client.guilds.cache.map(restoreTodayActiveMembers),
    );
    await Promise.allSettled(client.guilds.cache.map(syncChannelAccess));
    await Promise.allSettled(client.guilds.cache.map(syncServerVoiceSession));
    await purgeExpiredMessages();
    void pollHistoryImportJobs();
  } catch (error) {
    console.error("Initial member sync failed:", error);
  }
});

client.on("guildCreate", (guild) =>
  void (async () => {
    await syncGuildRegistry(guild);
    if (await leaveBlockedGuild(guild, "re-invite")) return;
    await Promise.allSettled([
      syncGuildCommands(guild.id),
      updateMemberCount(guild),
      restoreTodayActiveMembers(guild),
      syncChannelAccess(guild),
      syncServerVoiceSession(guild),
    ]);
  })(),
);

client.on("guildDelete", (guild) => {
  void markGuildDisconnected(guild.id).catch((error) =>
    console.error("Failed to mark removed guild as disconnected:", error),
  );
});

client.on("interactionCreate", async (interaction) => {
  if (
    interaction.isMessageContextMenuCommand() &&
    interaction.commandName === "NuviloChan 翻訳"
  ) {
    const content = interaction.targetMessage.content;
    if (!content.trim()) {
      await interaction.reply({
        content: "テキストを含むメッセージだけ翻訳できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let availableLanguages;
    try {
      availableLanguages = await getLibreTranslateLanguages();
    } catch (error) {
      console.error("Local translation service is unavailable:", error.message);
      await interaction.editReply(
        "ローカル翻訳サービスに接続できません。Bot用PCが起動しているか、少し待ってからお試しください。",
      );
      return;
    }
    if (availableLanguages.length === 0) {
      await interaction.editReply(
        "翻訳用の言語モデルを準備中です。少し待ってからもう一度お試しください。",
      );
      return;
    }
    const supportedLanguages = new Set(
      availableLanguages.map((language) => language.code),
    );
    const languageNames = new Map(
      availableLanguages.map((language) => [language.code, language.name]),
    );
    const requestId = createTranslationRequest(interaction.user.id, content, {
      supportedLanguages,
      languageNames,
      availableLanguages,
    });
    await interaction.editReply({
      content:
        `翻訳先を選択してください。結果はあなたにだけ表示され、メッセージ本文・翻訳結果は保存されません。\n-# LibreTranslate v${libreTranslateVersion} · ローカル処理`,
      components: createTranslationLanguagePicker(requestId, availableLanguages),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("nvtranslate:")) {
    const requestId = interaction.customId.split(":")[1];
    const request = getTranslationRequest(requestId, interaction.user.id);
    if (!request) {
      await interaction.reply({
        content: "この翻訳操作は期限切れです。もう一度メッセージを選択してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const targetLanguage = interaction.values[0];
    if (targetLanguage.startsWith("__nvpage:")) {
      const page = Number.parseInt(targetLanguage.slice("__nvpage:".length), 10);
      if (!Number.isInteger(page) || page < 0) {
        await interaction.reply({
          content: "言語一覧を開けませんでした。もう一度お試しください。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.update({
        components: createTranslationLanguagePicker(
          requestId,
          request.supportedLanguages.availableLanguages,
          page,
        ),
      });
      return;
    }
    await interaction.deferUpdate();
    try {
      const translated = await translateMessageText({
        content: request.content,
        targetLanguage,
        userId: interaction.user.id,
      });
      translationRequests.delete(requestId);
      const embed = new EmbedBuilder()
        .setColor(0x56b6ff)
        .setTitle(`${request.supportedLanguages.languageNames.get(targetLanguage) ?? getLanguageLabel(targetLanguage)} に翻訳`)
        .setDescription(translated.text.slice(0, 4_000))
        .setFooter({
          text: `検出言語: ${translated.detectedLanguage ?? "自動"} · 今月の残り処理枠: ${translated.remainingCharacters.toLocaleString("ja-JP")}文字`,
        });
      await interaction.editReply({ embeds: [embed], components: [] });
    } catch (error) {
      console.error("Message translation failed:", error.message);
      await interaction.editReply({
        content:
          error.code === "MONTHLY_LIMIT" || error.code === "RATE_LIMIT"
            ? error.message
            : "翻訳に失敗しました。少し待ってからもう一度お試しください。",
        components: [],
        embeds: [],
      });
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("nvtranslatecustom:")) {
    const requestId = interaction.customId.slice("nvtranslatecustom:".length);
    const request = getTranslationRequest(requestId, interaction.user.id);
    const targetLanguage = interaction.fields.getTextInputValue("language_code").trim();
    if (!request) {
      await interaction.reply({
        content: "この翻訳操作は期限切れです。もう一度メッセージを選択してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(targetLanguage) ||
      !request.supportedLanguages.supportedLanguages.has(targetLanguage)
    ) {
      await interaction.reply({
        content: "このローカル翻訳に対応していない言語コードです。例: `ar`、`de`、`ga`、`hi`、`zh`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const translated = await translateMessageText({
        content: request.content,
        targetLanguage,
        userId: interaction.user.id,
      });
      translationRequests.delete(requestId);
      const embed = new EmbedBuilder()
        .setColor(0x56b6ff)
        .setTitle(`${request.supportedLanguages.languageNames.get(targetLanguage) ?? targetLanguage} に翻訳`)
        .setDescription(translated.text.slice(0, 4_000))
        .setFooter({
          text: `検出言語: ${translated.detectedLanguage ?? "自動"} · 今月の残り処理枠: ${translated.remainingCharacters.toLocaleString("ja-JP")}文字`,
        });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Message translation failed:", error.message);
      await interaction.editReply(
        error.code === "MONTHLY_LIMIT" || error.code === "RATE_LIMIT"
          ? error.message
          : "翻訳に失敗しました。言語コードを確認して、少し待ってからもう一度お試しください。",
      );
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "cmup") {
    if (
      !developerGuildId ||
      interaction.guildId !== developerGuildId ||
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    ) {
      await interaction.reply({
        content: "このコマンドは開発用サーバーでサーバー管理権限を持つメンバーのみ実行できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const previousAttempt = commandSyncAttempts.get(interaction.user.id) ?? 0;
    const remainingSeconds = Math.ceil(
      (commandSyncCooldownMs - (Date.now() - previousAttempt)) / 1000,
    );
    if (remainingSeconds > 0) {
      await interaction.reply({
        content: `コマンド更新は${remainingSeconds}秒後に再実行できます。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    commandSyncAttempts.set(interaction.user.id, Date.now());
    try {
      await getRestClient().put(
        Routes.applicationGuildCommands(applicationId, developerGuildId),
        { body: getGuildCommandDefinitions(developerGuildId) },
      );
      await interaction.reply({
        content: "✅ 開発用サーバーのコマンドを即時更新しました。",
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error("Developer command sync failed:", error);
      await interaction.reply({
        content: "コマンド更新に失敗しました。Botログを確認してください。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (interaction.commandName === "commandupdate") {
    if (!(await requireGuildManager(interaction))) return;
    const previousAttempt = guildCommandSyncAttempts.get(interaction.guildId) ?? 0;
    const remainingSeconds = Math.ceil(
      (guildCommandSyncCooldownMs - (Date.now() - previousAttempt)) / 1000,
    );
    if (remainingSeconds > 0) {
      await interaction.reply({
        content: `このサーバーのコマンド更新は${remainingSeconds}秒後に再実行できます。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await syncGuildCommands(interaction.guildId);
      guildCommandSyncAttempts.set(interaction.guildId, Date.now());
      await interaction.editReply(
        "✅ このサーバーのBotコマンドを即時更新しました。入力欄で `/` を開き直すと新しいコマンドが表示されます✨",
      );
    } catch (error) {
      console.error("Guild command sync failed:", error);
      await interaction.editReply(
        "コマンド更新に失敗しました。しばらくしてからもう一度お試しください。",
      );
    }
    return;
  }

  if (interaction.commandName === "botservers") {
    if (!canUseBotServers(interaction)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const previousAttempt = botServersAttempts.get(interaction.user.id) ?? 0;
    const remainingSeconds = Math.ceil(
      (commandSyncCooldownMs - (Date.now() - previousAttempt)) / 1000,
    );
    if (remainingSeconds > 0) {
      await interaction.reply({
        content: `サーバー一覧は${remainingSeconds}秒後に再表示できます。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    botServersAttempts.set(interaction.user.id, Date.now());

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guilds = [...client.guilds.cache.values()]
      .filter((guild) => !isGuildBlocked(guild.id))
      .sort((left, right) =>
      left.name.localeCompare(right.name, "ja"),
      );
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(guilds.length / pageSize));
    const requestedPage = interaction.options.getInteger("page") ?? 1;
    const page = Math.min(Math.max(requestedPage, 1), totalPages);
    const currentGuilds = guilds.slice((page - 1) * pageSize, page * pageSize);
    const embeds = await Promise.all(
      currentGuilds.map(async (guild) => {
        const owner = await guild.fetchOwner().catch(() => null);
        const ownerName = owner
          ? formatGuildName(owner.displayName || owner.user.username)
          : "取得できませんでした";
        const ownerValue = owner
          ? `表示名: ${ownerName}\nユーザー名: @${formatGuildName(owner.user.username)}\nID: \`${owner.id}\``
          : ownerName;
        const iconUrl = guild.iconURL({ extension: "png", size: 128 });
        const embed = new EmbedBuilder()
          .setColor(0x7877ff)
          .setTitle(formatGuildName(guild.name))
          .addFields(
            { name: "コピー用ID", value: `\`${guild.id}\``, inline: true },
            {
              name: "メンバー数",
              value: `${guild.memberCount.toLocaleString("ja-JP")} members`,
              inline: true,
            },
            { name: "サーバー所有者", value: ownerValue, inline: false },
          );
        if (iconUrl) embed.setThumbnail(iconUrl);
        return embed;
      }),
    );
    if (embeds.length === 0) {
      embeds.push(
        new EmbedBuilder()
          .setColor(0x7877ff)
          .setTitle("NuviloChan Bot — Server Inventory")
          .setDescription("Botが導入されているサーバーはありません。"),
      );
    }
    embeds[0].setAuthor({
      name: `NuviloChan Bot — Server Inventory · ${guilds.length.toLocaleString("ja-JP")} servers · Page ${page}/${totalPages}`,
    });
    await interaction.editReply({
      embeds,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (interaction.commandName === "guildblock") {
    if (!canUseBotServers(interaction)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const guildId = interaction.options.getString("server_id", true).trim();
    const reason = interaction.options.getString("reason", true).trim();
    if (!/^\d{16,22}$/.test(guildId)) {
      await interaction.reply({
        content: "サーバーIDの形式が正しくありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (guildId === developerGuildId) {
      await interaction.reply({
        content: "開発用サーバー自身はブロックできません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await sql`
        INSERT INTO "bot_guild_blocklist" ("guildId", "reason", "blockedBy")
        VALUES (${guildId}, ${reason}, ${interaction.user.id})
        ON CONFLICT ("guildId")
        DO UPDATE SET "reason" = EXCLUDED."reason", "blockedBy" = EXCLUDED."blockedBy", "blockedAt" = now()
      `;
      await recordBlockAudit({
        guildId,
        action: "block",
        reason,
        performedBy: interaction.user.id,
        performedByName: interaction.user.username,
      });
      blockedGuildIds.add(guildId);
      await purgeGuildData(guildId);
      await interaction.editReply(
        `✅ サーバー \`${guildId}\` を停止リストに追加し、分析データを削除しました。Botは直ちに退出し、再招待されても自動退出します。\n理由: ${reason}`,
      );
      const guild = client.guilds.cache.get(guildId);
      if (guild) await leaveBlockedGuild(guild, "developer block");
    } catch (error) {
      console.error("Guild block failed:", error);
      await interaction.editReply(
        "サーバー停止の処理に失敗しました。Botログを確認してください。",
      );
    }
    return;
  }

  if (interaction.commandName === "guildunblock") {
    if (!canUseBotServers(interaction)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const guildId = interaction.options.getString("server_id", true).trim();
    if (!/^\d{16,22}$/.test(guildId)) {
      await interaction.reply({
        content: "サーバーIDの形式が正しくありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await sql`DELETE FROM "bot_guild_blocklist" WHERE "guildId" = ${guildId}`;
    await recordBlockAudit({
      guildId,
      action: "unblock",
      performedBy: interaction.user.id,
      performedByName: interaction.user.username,
    });
    blockedGuildIds.delete(guildId);
    await interaction.reply({
      content: `✅ サーバー \`${guildId}\` の停止を解除しました。Botは自動では戻らないため、必要なら通常の招待URLから再導入してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "guildblocks") {
    if (!canUseBotServers(interaction)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const rows = await sql`
      SELECT "guildId", "reason", "blockedBy", "blockedAt"
      FROM "bot_guild_blocklist"
      ORDER BY "blockedAt" DESC
      LIMIT 25
    `;
    const embed = new EmbedBuilder()
      .setColor(0xf05d5e)
      .setTitle("NuviloChan Bot — Blocked Servers")
      .setDescription(
        rows.length
          ? rows
              .map(
                (row) =>
                  `• \`${row.guildId}\` — ${formatGuildName(row.reason)}\n  <t:${Math.floor(new Date(row.blockedAt).getTime() / 1000)}:R>`,
              )
              .join("\n")
          : "停止しているサーバーはありません。",
      )
      .setFooter({ text: "Developer only · Block records are retained to reject re-invites." });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "diagnostics") {
    if (!canUseBotServers(interaction)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const [accessRows] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE "canRead" = false)::int AS "unreadableChannelCount",
          MAX("checkedAt") AS "lastPermissionCheckAt"
        FROM "bot_channel_access"
      `,
    ]);
    const access = accessRows[0] ?? {};
    const latency = client.ws.ping >= 0 ? `${client.ws.ping}ms` : "計測中";
    const uptimeSeconds = client.readyAt
      ? Math.floor((Date.now() - client.readyAt.getTime()) / 1000)
      : 0;
    const embed = new EmbedBuilder()
      .setColor(0x7877ff)
      .setTitle("NuviloChan Bot — Diagnostics")
      .addFields(
        {
          name: "Gateway",
          value: `🟢 Online\nLatency: ${latency}\nUptime: ${formatDuration(uptimeSeconds)}`,
          inline: true,
        },
        {
          name: "Guild cache",
          value: `${client.guilds.cache.size.toLocaleString("ja-JP")} servers`,
          inline: true,
        },
        {
          name: "Permission checks",
          value: `Unreadable channels: ${Number(access.unreadableChannelCount ?? 0).toLocaleString("ja-JP")}\nLast: ${formatTimestamp(access.lastPermissionCheckAt)}`,
          inline: true,
        },
      )
      .setFooter({ text: "Developer-only diagnostic output" });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "permissions") {
    if (!(await requireGuildManager(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const access = await getChannelAccessStatus(interaction.guildId);
      if (!access.lastCheckedAt) {
        await interaction.editReply(
          "Botのチャンネル権限をまだ確認できていません。Botがオンラインになってから少し待ってください。",
        );
        return;
      }
      if (access.unreadableChannelCount === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x39c58b)
          .setTitle("チャンネル権限")
          .setDescription("✅ 監視対象のチャンネルはすべて読み取り可能です。")
          .addFields({
            name: "最終確認",
            value: formatTimestamp(access.lastCheckedAt),
            inline: true,
          })
          .setFooter({ text: "この表示はサーバー管理者のみに公開されます。" });
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      const pageSize = 15;
      const totalPages = Math.ceil(access.unreadableChannelNames.length / pageSize);
      const requestedPage = interaction.options.getInteger("page") ?? 1;
      const page = Math.min(Math.max(requestedPage, 1), totalPages);
      const names = access.unreadableChannelNames.slice(
        (page - 1) * pageSize,
        page * pageSize,
      );
      const embed = new EmbedBuilder()
        .setColor(0xf0ad4e)
        .setTitle("チャンネル権限の確認")
        .setDescription(
          `⚠️ ${access.unreadableChannelCount.toLocaleString("ja-JP")}件のチャンネルで、Botに「チャンネルを見る」または「メッセージ履歴を読む」権限がありません。`,
        )
        .addFields({
          name: `読み取れないチャンネル（${page}/${totalPages}）`,
          value: names.map((name) => `• #${formatGuildName(name)}`).join("\n"),
        })
        .setFooter({
          text: `最終確認: ${formatTimestamp(access.lastCheckedAt)} · この表示は管理者のみ`,
        });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Permission check command failed:", error);
      await interaction.editReply("チャンネル権限を取得できませんでした。");
    }
    return;
  }

  if (interaction.commandName === "suc") {
    if (!(await requireGuildManager(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const [activity, access] = await Promise.all([
        getTodayActivity(interaction.guildId),
        getChannelAccessStatus(interaction.guildId),
      ]);
      const setupComplete = Boolean(access.lastCheckedAt) && access.unreadableChannelCount === 0;
      const initialSetupLabel = !access.lastCheckedAt
        ? "⏳ 権限の確認中です。少し待ってから再実行してください。"
        : setupComplete
          ? "✅ 完了 — 読み取れないチャンネルはありません。"
          : `⚠️ 読み取れないチャンネルが${access.unreadableChannelCount}件あります。`;
      const accessLabel = !access.lastCheckedAt
        ? "⏳ 確認中"
        : access.unreadableChannelCount > 0
          ? `⚠️ ${access.unreadableChannelCount}件で権限不足\n/permissions で詳細を確認`
          : "✅ すべての監視対象チャンネルを読み取れます";
      const embed = new EmbedBuilder()
        .setColor(access.unreadableChannelCount > 0 ? 0xf0ad4e : 0x5d7cff)
        .setTitle("NuviloChan Bot — Setup Check")
        .addFields(
          {
            name: "接続状態",
            value: `✅ オンライン\nGateway遅延: ${client.ws.ping >= 0 ? `${client.ws.ping}ms` : "計測中"}`,
            inline: true,
          },
          {
            name: "データ記録",
            value: `${activity.lastRecordedAt ? "✅" : "⏳"} 最終記録: ${formatTimestamp(activity.lastRecordedAt)}\n今日の送信数: ${activity.messageCount.toLocaleString("ja-JP")}`,
            inline: true,
          },
          {
            name: "チャンネル権限",
            value: accessLabel,
            inline: true,
          },
          {
            name: "初期設定",
            value: initialSetupLabel,
            inline: false,
          },
          {
            name: "権限の付与方法",
            value:
              "Botのロール、またはBotに付与したロール（例：`Member`）へ、必要な「チャンネルを見る」「メッセージ履歴を読む」権限を許可してください。\n※ **管理者** 権限は付与しないでください。",
            inline: false,
          },
          { name: "ダッシュボード", value: dashboardUrl, inline: false },
        )
        .setFooter({ text: "詳細な権限一覧は /permissions で確認できます。" });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Setup check command failed:", error);
      await interaction.editReply("セットアップ状態を取得できませんでした。");
    }
    return;
  }

  if (interaction.commandName === "week") {
    if (!(await requireGuildManager(interaction))) return;
    await interaction.deferReply();
    try {
      const activity = await getWeekActivity(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(0x56b6ff)
        .setTitle("直近7日間のサーバーアクティビティ")
        .setDescription("NuviloViewが記録している、このサーバーの直近7日間の要約です。")
        .addFields(
          {
            name: "アクティブメンバー",
            value: `${activity.activeMemberCount.toLocaleString("ja-JP")}人`,
            inline: true,
          },
          {
            name: "送信メッセージ",
            value: `${activity.messageCount.toLocaleString("ja-JP")}件`,
            inline: true,
          },
          {
            name: "サーバー通話時間",
            value: formatDuration(activity.voiceSeconds),
            inline: true,
          },
          {
            name: "平均リアクション率",
            value: `${activity.reactionRate.toFixed(1)}%`,
            inline: true,
          },
          {
            name: "最も動いたチャンネル",
            value: activity.topChannel
              ? `#${formatGuildName(activity.topChannel.name)} — ${activity.topChannel.messageCount.toLocaleString("ja-JP")}件`
              : "記録されたメッセージはまだありません",
            inline: true,
          },
          { name: "詳しい分析", value: dashboardUrl, inline: false },
        )
        .setFooter({ text: "コマンド実行サーバーのデータだけを集計しています。" });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Week activity command failed:", error);
      await interaction.editReply("直近7日間のアクティビティを取得できませんでした。");
    }
    return;
  }

  if (interaction.commandName === "dashboard") {
    if (!(await requireGuildManager(interaction))) return;
    await interaction.reply({
      content: `このサーバーの分析は ${dashboardUrl} から確認できます。Discordでログイン後、対象のサーバーを選択してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "privacy") {
    const embed = new EmbedBuilder()
      .setColor(0x7877ff)
      .setTitle("NuviloChan Bot — Privacy")
      .setDescription("NuviloChan Botはサーバー分析のために必要なデータだけを記録します。")
      .addFields(
        {
          name: "記録する内容",
          value: "メンバー数、メッセージ数、リアクション、参加・退出、発言者数、サーバー単位の通話時間、チャンネル権限状態",
        },
        {
          name: "メッセージ本文",
          value: `検索機能のため、Botが閲覧できるチャンネルの本文を最大${messageRetentionDays}日間保存します。削除イベントを受信した本文は記録からも削除します。`,
        },
        {
          name: "保存しないもの",
          value: "音声通話の内容は取得・保存しません。",
        },
        { name: "詳細", value: `${dashboardUrl}privacy` },
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === "stc") {
    if (!(await requireGuildManager(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const activity = await getTodayActivity(interaction.guildId);
      const latency = client.ws.ping >= 0 ? `${client.ws.ping}ms` : "計測中";
      const embed = new EmbedBuilder()
        .setColor(0x5d7cff)
        .setTitle("NuviloChan Bot — Status Check")
        .setDescription("このサーバーでのBot稼働・データ記録の状態です。")
        .addFields(
          {
            name: "接続状態",
            value: `🟢 オンライン\nGateway遅延: ${latency}`,
            inline: true,
          },
          {
            name: "データ記録",
            value: `最終記録: ${formatTimestamp(activity.lastRecordedAt)}\n今日の送信数: ${activity.messageCount.toLocaleString("ja-JP")}`,
            inline: true,
          },
          {
            name: "保存設定",
            value: `メッセージ保持期間: ${messageRetentionDays}日\n削除済みメッセージは記録からも削除されます。`,
            inline: false,
          },
          { name: "ダッシュボード", value: dashboardUrl, inline: false },
        )
        .setFooter({ text: "この表示はサーバー管理者のみに公開されます。" });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Status check failed:", error);
      await interaction.editReply(
        "ステータスの取得に失敗しました。しばらくしてからもう一度お試しください。",
      );
    }
    return;
  }

  if (interaction.commandName === "tactive") {
    if (!(await requireGuildManager(interaction))) return;
    await interaction.deferReply();
    try {
      const activity = await getTodayActivity(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(0x56b6ff)
        .setTitle("今日のサーバーアクティビティ")
        .setDescription("NuviloViewが記録している、今日のこのサーバーの活動です。")
        .addFields(
          {
            name: "アクティブメンバー",
            value: `${activity.activeMemberCount.toLocaleString("ja-JP")}人`,
            inline: true,
          },
          {
            name: "送信メッセージ",
            value: `${activity.messageCount.toLocaleString("ja-JP")}件`,
            inline: true,
          },
          {
            name: "サーバー通話時間",
            value: formatDuration(activity.voiceSeconds),
            inline: true,
          },
          {
            name: "最も動いたチャンネル",
            value: activity.topChannel
              ? `#${activity.topChannel.name} — ${activity.topChannel.messageCount.toLocaleString("ja-JP")}件`
              : "今日のメッセージはまだありません",
            inline: false,
          },
          { name: "詳しい分析", value: dashboardUrl, inline: false },
        )
        .setFooter({ text: "コマンド実行サーバーのデータだけを集計しています。" });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Today's activity command failed:", error);
      await interaction.editReply(
        "今日のアクティビティを取得できませんでした。しばらくしてからもう一度お試しください。",
      );
    }
    return;
  }

  if (interaction.commandName !== "help") return;
  const embed = new EmbedBuilder()
    .setColor(0x7877ff)
    .setTitle("NuviloChan Bot — Help")
    .setDescription(
      "NuviloChan Botは、サーバーの活動をNuviloViewへ記録する分析Botです。\nコマンドは入力欄で `/` を入力して選択できます。",
    )
    .addFields(
      {
        name: "🟦　**/tactive**",
        value:
          "━━━━━━━━━━━━━━━━━━\n今日のアクティブメンバー・送信数・サーバー通話時間を表示します。",
        inline: false,
      },
      {
        name: "🟪　**/week**",
        value:
          "━━━━━━━━━━━━━━━━━━\n直近7日間の活動、通話時間、最も動いたチャンネルを表示します。",
        inline: false,
      },
      {
        name: "🟩　**/suc**",
        value:
          "━━━━━━━━━━━━━━━━━━\n初期設定・データ記録・チャンネル権限の状態をまとめて確認します。",
        inline: false,
      },
      {
        name: "🟨　**/permissions**",
        value:
          "━━━━━━━━━━━━━━━━━━\nBotが読み取れないチャンネルと、不足している権限を確認します。",
        inline: false,
      },
      {
        name: "🟦　**/dashboard**",
        value:
          "━━━━━━━━━━━━━━━━━━\nNuviloViewダッシュボードを開くリンクを表示します。",
        inline: false,
      },
      {
        name: "⬜　**/privacy**",
        value:
          "━━━━━━━━━━━━━━━━━━\n記録するデータ、メッセージ本文の保持期間、保存しない情報を表示します。",
        inline: false,
      },
      {
        name: "🟧　**/commandupdate**",
        value:
          "━━━━━━━━━━━━━━━━━━\nこのサーバーのBotコマンドを即時更新します。更新直後に新機能を使いたいときに実行してください。",
        inline: false,
      },
      {
        name: "🔒　利用できる人",
        value:
          "`/help` と `/privacy` は全員利用できます。その他はサーバー管理権限を持つメンバーのみ実行できます。",
        inline: false,
      },
      {
        name: "🔗　ダッシュボード・プライバシー",
        value: `${dashboardUrl}\n${dashboardUrl}privacy`,
        inline: false,
      },
    )
    .setFooter({ text: "分析の閲覧にはサーバー管理権限が必要です。" });

  await interaction.reply({ embeds: [embed] });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || isGuildBlocked(message.guild.id)) return;

  try {
    await sql`
      INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "date")
      VALUES (${message.guild.id}, ${message.guild.memberCount}, 1, CURRENT_DATE)
      ON CONFLICT ("guildId", "date")
      DO UPDATE SET
        "messageCount" = "daily_stats"."messageCount" + 1,
        "memberCount" = EXCLUDED."memberCount",
        "updatedAt" = now()
    `;
    const channelName = "name" in message.channel ? message.channel.name : null;
    await Promise.all([
      recordActivity({
        guildId: message.guild.id,
        type: "message",
        actorName: message.member?.displayName ?? message.author.username,
        channelName,
      }),
      recordActiveMember({
        guildId: message.guild.id,
        userId: message.author.id,
      }),
      storeMessage(message),
    ]);
  } catch (error) {
    console.error("Failed to count a Discord message:", error);
  }
});

client.on("messageUpdate", async (_before, after) => {
  try {
    await storeMessage(after.partial ? await after.fetch() : after);
  } catch (error) {
    console.error("Failed to update a stored Discord message:", error);
  }
});

client.on("messageDelete", async (message) => {
  try {
    await sql`DELETE FROM "discord_message" WHERE "id" = ${message.id}`;
  } catch (error) {
    console.error("Failed to remove a deleted Discord message:", error);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (
    user.bot ||
    !reaction.message.guild ||
    isGuildBlocked(reaction.message.guild.id)
  )
    return;
  try {
    const guild = reaction.message.guild;
    await sql`
      INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "reactionCount", "date")
      VALUES (${guild.id}, ${guild.memberCount}, 0, 1, CURRENT_DATE)
      ON CONFLICT ("guildId", "date")
      DO UPDATE SET
        "reactionCount" = "daily_stats"."reactionCount" + 1,
        "memberCount" = EXCLUDED."memberCount",
        "updatedAt" = now()
    `;
  } catch (error) {
    console.error("Failed to count a Discord reaction:", error);
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;
  if (isGuildBlocked(newState.guild.id)) return;
  void syncServerVoiceSession(newState.guild).catch((error) =>
    console.error("Failed to sync server voice activity:", error),
  );
});

client.on(
  "guildMemberAdd",
  (member) => {
    if (isGuildBlocked(member.guild.id)) return;
    return (
    void Promise.all([
      updateMemberCount(member.guild),
      recordActivity({
        guildId: member.guild.id,
        type: "member_joined",
        actorName: member.displayName,
      }),
    ])
    );
  },
);
client.on(
  "guildMemberRemove",
  (member) => {
    if (isGuildBlocked(member.guild.id)) return;
    return (
    void Promise.all([
      updateMemberCount(member.guild),
      recordActivity({
        guildId: member.guild.id,
        type: "member_left",
        actorName: member.user.username,
      }),
      syncServerVoiceSession(member.guild),
    ])
    );
  },
);
client.on("error", (error) => {
  console.error("Discord client error:", error);
  void reportOperationalAlert("Discord client error", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Bot rejection:", error);
  void reportOperationalAlert("Unhandled Bot error", error);
});

setInterval(
  () => {
    void Promise.allSettled(
      client.guilds.cache.map(async (guild) => {
        await updateMemberCount(guild);
        await syncChannelAccess(guild);
        await syncGuildRegistry(guild);
      }),
    );
  },
  15 * 60 * 1000,
);

setInterval(() => {
  void recordBotHeartbeat().catch((error) =>
    console.error("Failed to record Bot heartbeat:", error),
  );
}, 60 * 1000);

setInterval(() => {
  void enforceBlockedGuilds().catch((error) =>
    console.error("Failed to refresh the blocked guild list:", error),
  );
}, 15 * 1000);

setInterval(
  () => {
    void purgeExpiredMessages().catch((error) =>
      console.error("Failed to purge expired messages:", error),
    );
  },
  12 * 60 * 60 * 1000,
);

setInterval(() => {
  void pollHistoryImportJobs().catch((error) =>
    console.error("Failed to poll history import jobs:", error),
  );
}, 30 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, request] of translationRequests) {
    if (request.expiresAt < now) translationRequests.delete(id);
  }
}, 60 * 1000);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Disconnecting NuviloChan Bot...`);
  try {
    await sql`
      UPDATE "bot_heartbeat"
      SET "stoppedAt" = now()
      WHERE "id" = ${botHeartbeatId}
    `;
  } catch (error) {
    console.error("Failed to mark Bot as stopped:", error);
  }
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await client.login(process.env.DISCORD_BOT_TOKEN);
