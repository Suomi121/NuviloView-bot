import {
  ActionRowBuilder,
  ActivityType,
  ApplicationCommandType,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SectionBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
} from "discord.js";
import { neon } from "@neondatabase/serverless";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createGuildResetService } from "./lib/guild-reset-service.mjs";
import { getGuildResetConfig, isResetDeveloper, parseIdList } from "./lib/guild-reset-utils.mjs";
import { createNukeProtectionService } from "./lib/nuke-protection-service.mjs";
import {
  RUNTIME_EXIT_CODES,
  RuntimeCoordinator,
  createRuntimeIdentity,
  createRuntimeLeaseRepository,
  getRuntimeConfig,
  validateRuntimeConfig,
} from "./lib/runtime-singleton.mjs";
import {
  formatModerationActionResult,
  getModerationTargetError,
  normalizeModerationReason,
  validateDiscordId,
  validateTimeoutMinutes,
} from "./lib/moderation-utils.mjs";
import {
  evaluateSecurityPermissionChecks,
  extractConfirmation,
  getSecurityCommandDefinition,
  parseDiscordTargetId,
  parseSecurityCommand,
  securityCommandDefinitions,
  securityPermissionCheckDefinitions,
} from "./lib/prefix-security-commands.mjs";
import {
  canUseDiscordNativeDice,
  createDiscordNativeDiceUrl,
  createDiceRollCustomId,
  entertainmentCommandDefinitions,
  formatDiceNotation,
  getEntertainmentCommandDefinition,
  parseDiceNotation,
  parseDiceRollCustomId,
  parseEntertainmentCommand,
  rollDice,
} from "./lib/entertainment-commands.mjs";
import {
  canManageSpamAction,
  createSpamActionCustomId,
  createSpamTracker,
  defaultSpamProtectionConfig,
  getAutomaticSpamProtectionBlockReason,
  parseSpamActionCustomId,
  shouldTrackSpamMessage,
} from "./lib/spam-protection.mjs";
import {
  SNIPE_HISTORY_LIMIT,
  SNIPE_RETENTION_MS,
  SNIPE_RESULT_SESSION_MS,
  canDeleteSnipeResult,
  createSnipeDeleteCustomId,
  createSnipePageCustomId,
  escapeSnipeText,
  getSnipeCleanupDelay,
  limitSnipeHistory,
  parseSnipeDeleteCustomId,
  parseSnipePageCustomId,
} from "./lib/snipe-utils.mjs";
import {
  getTranslationAutocompleteChoices,
  preferredTranslationLanguages,
  resolveAvailableTranslationLanguage,
} from "./lib/translation-command.mjs";
import {
  REACTION_ROLE_LIMIT,
  getDiscordReactionEmojiKey,
  isReactionRoleMessageId,
  normalizeReactionRoleIds,
  parseReactionRoleEmoji,
} from "./lib/reaction-role-utils.mjs";
import {
  MESSAGE_SOURCE,
  getMessageImportConfig,
} from "./lib/message-history-import.mjs";
import {
  createMessageHistoryImportRepository,
  createMessageHistoryImportWorker,
} from "./lib/message-history-import-worker.mjs";

if (!process.env.DATABASE_URL || !process.env.NUVILOVIEW_BOT_TOKEN) {
  throw new Error(
    "DATABASE_URL and NUVILOVIEW_BOT_TOKEN must be set before starting the bot.",
  );
}

const sql = neon(process.env.DATABASE_URL);
const runtimeConfig = getRuntimeConfig(process.env);
const runtimeIdentity = createRuntimeIdentity(process.env);
const runtimeRepository = createRuntimeLeaseRepository((text, parameters) =>
  sql.query(text, parameters),
);
const messageRetentionDays = Number.isInteger(
  Number(process.env.MESSAGE_RETENTION_DAYS),
)
  ? Math.min(Math.max(Number(process.env.MESSAGE_RETENTION_DAYS), 7), 365)
  : 90;
const messageImportConfig = getMessageImportConfig(process.env);
const libreTranslateUrl = (process.env.LIBRETRANSLATE_URL?.trim() || "http://127.0.0.1:5000").replace(/\/+$/, "");
const libreTranslateVersion = process.env.LIBRETRANSLATE_VERSION?.trim() || "1.9.6";
const translationMonthlyLimit = 600_000;
const translationRequestWindowMs = 60 * 1000;
const translationRequestLimit = 8;
const translationRequestLifetimeMs = 5 * 60 * 1000;
const inactivityAlertHours = 24;
const departureAlertThreshold = 3;

function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback;
}

const spamProtectionEnabled =
  process.env.SPAM_PROTECTION_ENABLED?.trim().toLowerCase() !== "false";
const spamMessageLimit = boundedEnvironmentInteger(
  "SPAM_MESSAGE_LIMIT",
  defaultSpamProtectionConfig.messageLimit,
  3,
  30,
);
const spamWindowMs =
  boundedEnvironmentInteger(
    "SPAM_WINDOW_SECONDS",
    defaultSpamProtectionConfig.windowMs / 1_000,
    2,
    60,
  ) * 1_000;
const spamTimeoutMinutes = boundedEnvironmentInteger(
  "SPAM_TIMEOUT_MINUTES",
  defaultSpamProtectionConfig.timeoutMinutes,
  1,
  1_440,
);
const spamDetectionCooldownMs =
  boundedEnvironmentInteger(
    "SPAM_DETECTION_COOLDOWN_MINUTES",
    defaultSpamProtectionConfig.detectionCooldownMs / 60_000,
    1,
    1_440,
  ) * 60_000;
const botStartedAt = new Date();
const botHeartbeatId = "primary";
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

const dashboardUrl = "https://nuviloview-oem.vercel.app/";
const applicationId = process.env.NUVILOVIEW_CLIENT_ID;
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
const messageHistoryImportRepository = createMessageHistoryImportRepository((text, parameters) =>
  sql.query(text, parameters),
);
const messageHistoryImportWorker = createMessageHistoryImportWorker({
  repository: messageHistoryImportRepository,
  discordClient: client,
  config: messageImportConfig,
  identity: runtimeIdentity,
  isGuildBlocked,
  roleIdsForMessage: (message) => analyticsRoleIds(message.member),
});
// Keep the last successful DB snapshots in memory. Gateway events may ask for
// the same inventory repeatedly, but unchanged JSON does not need to cross the
// Neon connection or rewrite every row again.
const channelAccessSnapshots = new Map();
const analyticsInventorySnapshots = new Map();
const guildResetConfig = getGuildResetConfig();
const nukeProtectionService = createNukeProtectionService({
  client,
  sql,
  environment: process.env,
});
let runtimeCoordinator = null;
const runtimeOperationalMetrics = {
  discordReadyAt: null,
  lastDiscordDisconnectAt: null,
  lastDiscordReconnectAt: null,
  lastDiscordResumeAt: null,
  lastDiscordInvalidSessionAt: null,
  lastDiscordErrorAt: null,
  lastDiscordLoginFailureAt: null,
  lastDiscordRateLimitAt: null,
  lastAnalyticsSuccessAt: null,
  lastAnalyticsFailureAt: null,
  disconnectCount: 0,
  reconnectCount: 0,
  rateLimitCount: 0,
};

function updateRuntimeOperationalMetrics(values) {
  Object.assign(runtimeOperationalMetrics, values);
  if (runtimeCoordinator) void runtimeCoordinator.recordNow();
}

let lastPresenceGuildCount = null;
const translationAttempts = new Map();
const translationRequests = new Map();
const moderationAttempts = new Map();
const moderationCooldownMs = 5 * 1000;
const entertainmentAttempts = new Map();
const entertainmentCooldownMs = 2 * 1000;
const spamTracker = createSpamTracker({
  messageLimit: spamMessageLimit,
  windowMs: spamWindowMs,
  detectionCooldownMs: spamDetectionCooldownMs,
});
const spamActionLocks = new Set();
const spamAlertMessages = new Map();
const reactionRoleRules = new Map();
const deletedMessageSnipes = new Map();
const snipeHistoryCleanupTimers = new Map();
const ignoredSnipeDeleteIds = new Set();
const snipeResultSessions = new Map();
const spamTrackerPruneTimer = setInterval(
  () => spamTracker.prune(),
  Math.max(spamWindowMs * 2, 60_000),
);
spamTrackerPruneTimer.unref();
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
const sucCommand = new SlashCommandBuilder()
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
const translateCommand = new SlashCommandBuilder()
  .setName("translate")
  .setDescription("入力したテキストをローカル翻訳します")
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName("text")
      .setDescription("翻訳するテキスト")
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(2_000),
  )
  .addStringOption((option) =>
    option
      .setName("language")
      .setDescription("翻訳先（省略すると一覧から選択）")
      .setAutocomplete(true),
  )
  .toJSON();
const zxCommand = new SlashCommandBuilder()
  .setName("zx")
  .setDescription("NuviloChanの娯楽コマンドを選びます")
  .setDMPermission(false)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("help")
      .setDescription("zx?で使える娯楽コマンドの一覧を表示します"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("dice")
      .setDescription("なにがでるかな…")
      .addStringOption((option) =>
        option
          .setName("dice")
          .setDescription("なにがでるかな…")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(8),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("snipe")
      .setDescription("このチャンネルで削除されたメッセージを表示します"),
  )
  .toJSON();
const setRollCommand = new SlashCommandBuilder()
  .setName("setroll")
  .setDescription("管理者用: リアクションで受け取れるロールを設定します")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) => {
    subcommand
      .setName("add")
      .setDescription("メッセージと絵文字へ最大10個のロールを設定します")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("対象メッセージがあるチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message_id")
          .setDescription("対象メッセージのID")
          .setRequired(true)
          .setMinLength(16)
          .setMaxLength(22),
      )
      .addStringOption((option) =>
        option
          .setName("emoji")
          .setDescription("付与に使用するUnicode絵文字またはカスタム絵文字")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(128),
      )
      .addRoleOption((option) =>
        option
          .setName("role_1")
          .setDescription("付与するロール1")
          .setRequired(true),
      );
    for (let index = 2; index <= REACTION_ROLE_LIMIT; index += 1) {
      subcommand.addRoleOption((option) =>
        option
          .setName(`role_${index}`)
          .setDescription(`付与するロール${index}`),
      );
    }
    return subcommand;
  })
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("登録済みのリアクションロール設定を削除します")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("対象メッセージがあるチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message_id")
          .setDescription("対象メッセージのID")
          .setRequired(true)
          .setMinLength(16)
          .setMaxLength(22),
      )
      .addStringOption((option) =>
        option
          .setName("emoji")
          .setDescription("削除する設定の絵文字")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(128),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("このサーバーのリアクションロール設定を表示します")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("このチャンネルの設定だけ表示します")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
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
const devResetPlanCommand = new SlashCommandBuilder()
  .setName("dev-reset-plan")
  .setDescription("開発者用: Guild初期化の安全なPlanを作成します")
  .addStringOption((option) =>
    option
      .setName("guild_id")
      .setDescription("対象Guild ID")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("mode")
      .setDescription("初期化モード（初期値: channels_only）")
      .addChoices(
        { name: "Channels only", value: "channels_only" },
        { name: "Channels and roles", value: "channels_and_roles" },
        { name: "Settings reset", value: "settings_reset" },
      ),
  )
  .addBooleanOption((option) =>
    option
      .setName("dry_run")
      .setDescription("Discord上のデータを変更せず検証します（初期値: true）"),
  )
  .addBooleanOption((option) =>
    option
      .setName("delete_channels")
      .setDescription("保護対象以外のチャンネルを削除対象にします（初期値: true）"),
  )
  .addBooleanOption((option) =>
    option
      .setName("delete_roles")
      .setDescription("ロール削除を明示的に有効化します（初期値: false）"),
  )
  .addBooleanOption((option) =>
    option
      .setName("reset_settings")
      .setDescription("Guild設定初期化を明示的に有効化します（初期値: false）"),
  )
  .addStringOption((option) =>
    option
      .setName("keep_channel_ids")
      .setDescription("追加で保護するチャンネルID（カンマ区切り）"),
  )
  .addStringOption((option) =>
    option
      .setName("keep_role_ids")
      .setDescription("追加で保護するロールID（カンマ区切り）"),
  )
  .addBooleanOption((option) =>
    option
      .setName("create_default_channels")
      .setDescription("実行後にgeneral/logs/rulesを作成します（初期値: false）"),
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("実行理由（監査記録用）")
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(300),
  )
  .toJSON();
const devResetCodeCommand = new SlashCommandBuilder()
  .setName("dev-reset-code")
  .setDescription("開発者用: 有効なReset Planのワンタイム確認コードを発行します")
  .addStringOption((option) =>
    option
      .setName("plan_id")
      .setDescription("Plan ID")
      .setRequired(true),
  )
  .toJSON();
const devResetConfirmCommand = new SlashCommandBuilder()
  .setName("dev-reset-confirm")
  .setDescription("開発者用: 確認コードを検証してReset Planを実行します")
  .addStringOption((option) =>
    option
      .setName("plan_id")
      .setDescription("Plan ID")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("code")
      .setDescription("Ephemeralで発行されたワンタイム確認コード")
      .setRequired(true)
      .setMinLength(6)
      .setMaxLength(12),
  )
  .addBooleanOption((option) =>
    option
      .setName("acknowledge")
      .setDescription("削除と復元制約の警告を理解した場合のみtrue")
      .setRequired(true),
  )
  .toJSON();
// Keep the public surface intentionally small. Detailed administration is
// available in the dashboard; the developer guild receives the extended set.
const publicCommands = [
  helpCommand,
  todayActiveCommand,
  serverCommandUpdateCommand,
  translateCommand,
  zxCommand,
];
// These are registered per guild so newly-added management tools can appear
// immediately without duplicating the small global command set.
const extendedCommands = [
  permissionsCommand,
  sucCommand,
  weekCommand,
  dashboardCommand,
  privacyCommand,
  translateMessageCommand,
  setRollCommand,
];
const developerCommands = [
  commandUpdateCommand,
  botServersCommand,
  diagnosticsCommand,
  guildBlockCommand,
  guildUnblockCommand,
  guildBlocksCommand,
  ...(guildResetConfig.enabled
    ? [devResetPlanCommand, devResetCodeCommand, devResetConfirmCommand]
    : []),
];

const guildResetService = createGuildResetService({
  client,
  sql,
  isGuildBlocked,
  botVersion: "0.1.0",
});

function getRestClient() {
  return new REST({ version: "10" }).setToken(process.env.NUVILOVIEW_BOT_TOKEN);
}

function safeErrorText(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replaceAll(process.env.NUVILOVIEW_BOT_TOKEN ?? "", "[REDACTED]")
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
      "NUVILOVIEW_CLIENT_ID must be set before registering slash commands.",
    );
  await getRestClient().put(
    Routes.applicationGuildCommands(applicationId, guildId),
    { body: getGuildCommandDefinitions(guildId) },
  );
}

async function registerCommands() {
  if (!applicationId)
    throw new Error(
      "NUVILOVIEW_CLIENT_ID must be set before registering slash commands.",
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

function canUseGuildReset(interaction) {
  return Boolean(
    guildResetConfig.enabled &&
      developerGuildId &&
      interaction.guildId === developerGuildId &&
      isResetDeveloper(interaction.user.id),
  );
}

function formatGuildName(name) {
  return name
    .replace(/[\\`*_~|]/g, "\\$&")
    .replace(/@/g, "＠")
    .slice(0, 80);
}

function formatResetTargets(items, emptyText, limit = 12) {
  if (!Array.isArray(items) || items.length === 0) return emptyText;
  const visible = items.slice(0, limit).map(
    (item) => `• ${formatGuildName(item.name ?? "名称なし")} (\`${item.id}\`)`,
  );
  if (items.length > limit) visible.push(`…ほか ${items.length - limit}件`);
  return visible.join("\n").slice(0, 1_024);
}

async function replyGuildResetError(interaction, error) {
  const output = guildResetService.publicError(error);
  const content = `❌ ${output.message}\n-# エラーコード: ${output.code}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
  } else {
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

async function handleDevResetPlanCommand(interaction) {
  if (!canUseGuildReset(interaction)) {
    await interaction.reply({
      content: "このコマンドを実行する権限がありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const plan = await guildResetService.createPlan({
      guildId: interaction.options.getString("guild_id", true).trim(),
      developerId: interaction.user.id,
      developerName: interaction.user.username,
      source: "bot_command",
      input: {
        mode: interaction.options.getString("mode") ?? "channels_only",
        dryRun: interaction.options.getBoolean("dry_run") ?? true,
        deleteChannels: interaction.options.getBoolean("delete_channels") ?? undefined,
        deleteRoles: interaction.options.getBoolean("delete_roles") ?? false,
        resetSettings: interaction.options.getBoolean("reset_settings") ?? false,
        keepChannelIds: parseIdList(interaction.options.getString("keep_channel_ids") ?? ""),
        keepRoleIds: parseIdList(interaction.options.getString("keep_role_ids") ?? ""),
        createDefaultChannels:
          interaction.options.getBoolean("create_default_channels") ?? false,
        reason: interaction.options.getString("reason", true),
      },
    });
    const summary = plan.targetSummary;
    const limitText = summary.limitExceeded
      ? `🔴 超過: ${summary.limitReasons.join("、")}`
      : `🟢 上限内（Channel ${summary.channelDeleteCount}/${summary.limits.maxChannelDeletes}、Role ${summary.roleDeleteCount}/${summary.limits.maxRoleDeletes}、合計 ${summary.totalOperationCount}/${summary.limits.maxTotalOperations}）`;
    const permissionText = summary.missingPermissions.length
      ? `不足: ${summary.missingPermissions.join(", ")}`
      : "必要権限を確認済み";
    const embed = new EmbedBuilder()
      .setColor(
        summary.limitExceeded || summary.missingPermissions.length
          ? 0xf0a34a
          : plan.dryRun
            ? 0x56b6ff
            : 0xed4245,
      )
      .setTitle(`Guild Reset Plan · ${formatGuildName(summary.guild.name)}`)
      .setDescription(
        [
          `**Mode:** \`${plan.mode}\``,
          `**Dry Run:** ${plan.dryRun ? "Yes（変更なし）" : "No（実変更あり）"}`,
          `**Guild:** \`${plan.guildId}\``,
          `**所有者:** ${formatGuildName(summary.guild.ownerName)} (\`${summary.guild.ownerId}\`)`,
          `**メンバー:** ${summary.guild.memberCount.toLocaleString("ja-JP")}`,
          `**現在:** ${summary.guild.channelCount} channels / ${summary.guild.roleCount} roles`,
        ].join("\n"),
      )
      .addFields(
        {
          name: `削除予定チャンネル · ${summary.deleteChannels.length}件`,
          value: formatResetTargets(summary.deleteChannels, "なし"),
        },
        {
          name: `保護チャンネル · ${summary.protectedChannels.length}件`,
          value: formatResetTargets(summary.protectedChannels, "なし"),
        },
        {
          name: `削除予定ロール · ${summary.deleteRoles.length}件`,
          value: formatResetTargets(summary.deleteRoles, "なし"),
        },
        {
          name: `保護ロール · ${summary.protectedRoles.length}件`,
          value: formatResetTargets(summary.protectedRoles, "なし"),
        },
        {
          name: "変更予定設定",
          value: summary.settingsChanges.length
            ? summary.settingsChanges.map((item) => `• ${item}`).join("\n").slice(0, 1_024)
            : "なし",
          inline: true,
        },
        { name: "実行上限", value: limitText.slice(0, 1_024), inline: true },
        { name: "Bot権限", value: permissionText, inline: true },
        {
          name: "警告",
          value: summary.warnings.map((warning) => `⚠️ ${warning}`).join("\n").slice(0, 1_024),
        },
        { name: "Plan ID", value: `\`${plan.id}\`` },
        {
          name: "Plan有効期限",
          value: `<t:${Math.floor(new Date(plan.expiresAt).getTime() / 1000)}:F>`,
        },
      )
      .setFooter({
        text: "この時点ではDiscord上のデータを変更していません。",
      });
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    await replyGuildResetError(interaction, error);
  }
}

async function handleDevResetCodeCommand(interaction) {
  if (!canUseGuildReset(interaction)) {
    await interaction.reply({
      content: "このコマンドを実行する権限がありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const issued = await guildResetService.issueCode({
      planId: interaction.options.getString("plan_id", true).trim(),
      developerId: interaction.user.id,
    });
    await interaction.editReply({
      content: [
        "🔐 **ワンタイム確認コード**",
        `\`${issued.code}\``,
        `有効期限: <t:${Math.floor(new Date(issued.expiresAt).getTime() / 1000)}:R>`,
        `Plan: \`${issued.plan.planId}\``,
        "",
        "このコードはこのEphemeralレスポンスにだけ表示されます。再発行すると古いコードは無効になります。",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyGuildResetError(interaction, error);
  }
}

async function handleDevResetConfirmCommand(interaction) {
  if (!canUseGuildReset(interaction)) {
    await interaction.reply({
      content: "このコマンドを実行する権限がありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.options.getBoolean("acknowledge", true) !== true) {
    await interaction.reply({
      content:
        "実行するには、削除と復元制約の警告を理解したうえで`acknowledge`をtrueにしてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const planId = interaction.options.getString("plan_id", true).trim();
  try {
    const guildId = await guildResetService.getPlanGuildId(planId, interaction.user.id);
    const result = await guildResetService.executePlan({
      planId,
      guildId,
      developerId: interaction.user.id,
      developerName: interaction.user.username,
      code: interaction.options.getString("code", true).trim(),
      source: "bot_command",
    });
    await interaction.editReply({
      content: [
        result.dryRun ? "✅ **Guild Reset Dry Run完了**" : "✅ **Guild Reset完了**",
        `Guild: ${formatGuildName(result.guildName)} (\`${result.guildId}\`)`,
        `Execution: \`${result.executionId}\``,
        `成功 ${result.successCount} / 失敗 ${result.failedCount} / スキップ ${result.skippedCount}`,
        `バックアップ: \`${result.backupFileName}\``,
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyGuildResetError(interaction, error);
  }
}

function getAvailableBotGuilds() {
  return [...client.guilds.cache.values()]
    .filter((guild) => !isGuildBlocked(guild.id))
    .sort((left, right) => left.name.localeCompare(right.name, "ja"));
}

function updateBotPresence() {
  if (!client.user) return;
  const guildCount = getAvailableBotGuilds().length;
  if (guildCount === lastPresenceGuildCount) return;

  client.user.setActivity(
    `NuviloView | Supporting ${guildCount} ${guildCount === 1 ? "server" : "servers"}`,
    { type: ActivityType.Playing },
  );
  lastPresenceGuildCount = guildCount;
}

const translationLanguages = preferredTranslationLanguages.map(
  ({ emoji, name, code }) => [emoji, name, code],
);

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

function createTranslationLanguageMetadata(availableLanguages) {
  return {
    supportedLanguages: new Set(
      availableLanguages.map((language) => language.code),
    ),
    languageNames: new Map(
      availableLanguages.map((language) => [language.code, language.name]),
    ),
    availableLanguages,
  };
}

function createTranslationResultEmbed({
  translated,
  targetLanguage,
  languageNames,
}) {
  return new EmbedBuilder()
    .setColor(0x56b6ff)
    .setTitle(
      `${languageNames.get(targetLanguage) ?? getLanguageLabel(targetLanguage)} に翻訳`,
    )
    .setDescription(translated.text.slice(0, 4_000))
    .setFooter({
      text:
        `検出言語: ${translated.detectedLanguage ?? "自動"} · ` +
        `今月の残り処理枠: ${translated.remainingCharacters.toLocaleString("ja-JP")}文字`,
    });
}

async function handleTranslateSlashCommand(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ利用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (isGuildBlocked(interaction.guildId)) {
    await interaction.reply({
      content: "このサーバーではBot機能が停止されています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const content = interaction.options.getString("text", true).trim();
  const requestedLanguage = interaction.options.getString("language")?.trim() ?? "";
  if (!content || [...content].length > 2_000) {
    await interaction.reply({
      content: "翻訳するテキストを1〜2000文字で入力してください。",
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

  const languageMetadata = createTranslationLanguageMetadata(availableLanguages);
  if (!requestedLanguage) {
    const requestId = createTranslationRequest(
      interaction.user.id,
      content,
      languageMetadata,
    );
    await interaction.editReply({
      content:
        "翻訳先を選択してください。結果はあなたにだけ表示され、入力本文・翻訳結果は保存されません。\n" +
        `-# LibreTranslate v${libreTranslateVersion} · ローカル処理`,
      components: createTranslationLanguagePicker(requestId, availableLanguages),
    });
    return;
  }

  const target = resolveAvailableTranslationLanguage(
    requestedLanguage,
    availableLanguages,
  );
  if (!target) {
    await interaction.editReply({
      content:
        `翻訳先 \`${requestedLanguage.slice(0, 40)}\` は現在のローカル翻訳に対応していません。` +
        "候補から選択するか、languageを省略して一覧を開いてください。",
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    const translated = await translateMessageText({
      content,
      targetLanguage: target.code,
      userId: interaction.user.id,
    });
    await interaction.editReply({
      embeds: [
        createTranslationResultEmbed({
          translated,
          targetLanguage: target.code,
          languageNames: languageMetadata.languageNames,
        }),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("Slash translation failed:", error.message);
    await interaction.editReply({
      content:
        error.code === "MONTHLY_LIMIT" || error.code === "RATE_LIMIT"
          ? error.message
          : "翻訳に失敗しました。少し待ってからもう一度お試しください。",
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
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
  updateBotPresence();
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
    sql`DELETE FROM "guild_member_event" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "discord_reaction_event" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "guild_channel_registry" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "guild_role_registry" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "analytics_health_snapshot" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "bot_channel_access" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "history_import_job" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "user_notification" WHERE "guildId" = ${guildId}`,
    sql`DELETE FROM "reaction_role_rule" WHERE "guildId" = ${guildId}`,
  ]);
  clearGuildReactionRoleRules(guildId);
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

const reactionRoleDeniedPermissions = [
  [PermissionFlagsBits.Administrator, "管理者"],
  [PermissionFlagsBits.ManageGuild, "サーバー管理"],
  [PermissionFlagsBits.ManageRoles, "ロール管理"],
  [PermissionFlagsBits.ManageChannels, "チャンネル管理"],
  [PermissionFlagsBits.ManageWebhooks, "ウェブフック管理"],
  [PermissionFlagsBits.BanMembers, "メンバーをBAN"],
  [PermissionFlagsBits.KickMembers, "メンバーをキック"],
  [PermissionFlagsBits.ModerateMembers, "メンバーをタイムアウト"],
  [PermissionFlagsBits.ManageMessages, "メッセージ管理"],
  [PermissionFlagsBits.MentionEveryone, "全員へのメンション"],
];

function reactionRoleRuleKey(guildId, messageId, emojiKey) {
  return `${guildId}:${messageId}:${emojiKey}`;
}

function clearGuildReactionRoleRules(guildId) {
  const prefix = `${guildId}:`;
  for (const key of reactionRoleRules.keys()) {
    if (key.startsWith(prefix)) reactionRoleRules.delete(key);
  }
}

async function loadReactionRoleRules(guildId = null) {
  const rows = guildId
    ? await sql`
        SELECT "id", "guildId", "channelId", "messageId", "emojiKey", "emojiDisplay", "roleIds"
        FROM "reaction_role_rule"
        WHERE "guildId" = ${guildId}
      `
    : await sql`
        SELECT "id", "guildId", "channelId", "messageId", "emojiKey", "emojiDisplay", "roleIds"
        FROM "reaction_role_rule"
      `;
  if (guildId) clearGuildReactionRoleRules(guildId);
  else reactionRoleRules.clear();
  for (const row of rows) {
    const roleIds = normalizeReactionRoleIds(row.roleIds);
    if (roleIds.length === 0) continue;
    reactionRoleRules.set(
      reactionRoleRuleKey(row.guildId, row.messageId, row.emojiKey),
      {
        id: Number(row.id),
        guildId: row.guildId,
        channelId: row.channelId,
        messageId: row.messageId,
        emojiKey: row.emojiKey,
        emojiDisplay: row.emojiDisplay,
        roleIds,
      },
    );
  }
}

function getReactionRoleSafetyError(role, guild, botMember) {
  if (!role || role.guild.id !== guild.id) return "別サーバーのロールは指定できません。";
  if (role.id === guild.id) return "@everyoneは指定できません。";
  if (role.managed) return `${role.name}はBot・連携サービスが管理するロールです。`;
  if (role.position >= botMember.roles.highest.position || !role.editable) {
    return `${role.name}はBotと同じか上位にあるため操作できません。`;
  }
  const dangerous = reactionRoleDeniedPermissions.find(([permission]) =>
    role.permissions.has(permission),
  );
  if (dangerous) return `${role.name}には「${dangerous[1]}」権限があるため登録できません。`;
  return null;
}

async function requireReactionRoleAdministrator(interaction) {
  if (
    interaction.inGuild() &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  await interaction.reply({
    content: "このコマンドはサーバーの管理者だけが実行できます。",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

async function handleSetRollCommand(interaction) {
  if (!(await requireReactionRoleAdministrator(interaction))) return;
  const guild = interaction.guild;
  const subcommand = interaction.options.getSubcommand(true);
  const selectedChannel = interaction.options.getChannel("channel");

  if (subcommand === "list") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rows = selectedChannel
      ? await sql`
          SELECT "channelId", "messageId", "emojiDisplay", "roleIds", "updatedAt"
          FROM "reaction_role_rule"
          WHERE "guildId" = ${guild.id} AND "channelId" = ${selectedChannel.id}
          ORDER BY "updatedAt" DESC
          LIMIT 50
        `
      : await sql`
          SELECT "channelId", "messageId", "emojiDisplay", "roleIds", "updatedAt"
          FROM "reaction_role_rule"
          WHERE "guildId" = ${guild.id}
          ORDER BY "updatedAt" DESC
          LIMIT 50
        `;
    if (rows.length === 0) {
      await interaction.editReply("リアクションロール設定はまだありません。");
      return;
    }
    const lines = rows.slice(0, 25).map((row, index) => {
      const roleIds = normalizeReactionRoleIds(row.roleIds);
      const roles = roleIds.map((roleId) => `<@&${roleId}>`).join(" ") || "有効なロールなし";
      const link = `https://discord.com/channels/${guild.id}/${row.channelId}/${row.messageId}`;
      return `${index + 1}. ${row.emojiDisplay} <#${row.channelId}> [メッセージ](${link})\n   ${roles}`;
    });
    await interaction.editReply({
      content: `**リアクションロール設定 — ${rows.length}件**\n${lines.join("\n").slice(0, 1_850)}`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const messageId = interaction.options.getString("message_id", true).trim();
  const parsedEmoji = parseReactionRoleEmoji(
    interaction.options.getString("emoji", true),
  );
  if (!isReactionRoleMessageId(messageId) || !parsedEmoji) {
    await interaction.reply({
      content: "メッセージIDまたは絵文字の形式が正しくありません。絵文字は1個だけ指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (
    !selectedChannel ||
    selectedChannel.guildId !== guild.id ||
    !selectedChannel.isTextBased() ||
    !("messages" in selectedChannel)
  ) {
    await interaction.reply({
      content: "このサーバーのテキストチャンネルを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "remove") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rows = await sql`
      DELETE FROM "reaction_role_rule"
      WHERE "guildId" = ${guild.id}
        AND "channelId" = ${selectedChannel.id}
        AND "messageId" = ${messageId}
        AND "emojiKey" = ${parsedEmoji.key}
      RETURNING "id"
    `;
    reactionRoleRules.delete(reactionRoleRuleKey(guild.id, messageId, parsedEmoji.key));
    await interaction.editReply(
      rows.length
        ? `✅ ${parsedEmoji.display} のリアクションロール設定を削除しました。すでに付与済みのロールは変更しません。`
        : "一致するリアクションロール設定はありません。",
    );
    return;
  }

  const roles = [];
  for (let index = 1; index <= REACTION_ROLE_LIMIT; index += 1) {
    const role = interaction.options.getRole(`role_${index}`);
    if (role && !roles.some((candidate) => candidate.id === role.id)) roles.push(role);
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply("Botに「ロールの管理」権限がないため設定できません。");
    return;
  }
  const channelPermissions = selectedChannel.permissionsFor(botMember);
  if (
    !channelPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !channelPermissions.has(PermissionFlagsBits.ReadMessageHistory) ||
    !channelPermissions.has(PermissionFlagsBits.AddReactions)
  ) {
    await interaction.editReply(
      "Botに対象チャンネルの閲覧・メッセージ履歴・リアクション追加権限が必要です。",
    );
    return;
  }
  const safetyErrors = roles
    .map((role) => getReactionRoleSafetyError(role, guild, botMember))
    .filter(Boolean);
  if (safetyErrors.length) {
    await interaction.editReply(`このロールは安全に付与できません。\n${safetyErrors.map((error) => `• ${error}`).join("\n")}`);
    return;
  }

  let targetMessage;
  try {
    targetMessage = await selectedChannel.messages.fetch(messageId);
    await targetMessage.react(parsedEmoji.reactionValue);
  } catch (error) {
    console.error("Reaction role target validation failed:", error);
    await interaction.editReply(
      "対象メッセージを取得できないか、その絵文字を追加できません。メッセージID・絵文字・Bot権限を確認してください。",
    );
    return;
  }

  const roleIds = roles.map((role) => role.id);
  const rows = await sql`
    INSERT INTO "reaction_role_rule" (
      "guildId", "channelId", "messageId", "emojiKey", "emojiDisplay", "roleIds", "createdBy"
    )
    VALUES (
      ${guild.id}, ${selectedChannel.id}, ${messageId}, ${parsedEmoji.key},
      ${parsedEmoji.display}, ${JSON.stringify(roleIds)}::jsonb, ${interaction.user.id}
    )
    ON CONFLICT ("guildId", "messageId", "emojiKey") DO UPDATE SET
      "channelId" = EXCLUDED."channelId",
      "emojiDisplay" = EXCLUDED."emojiDisplay",
      "roleIds" = EXCLUDED."roleIds",
      "createdBy" = EXCLUDED."createdBy",
      "updatedAt" = now()
    RETURNING "id"
  `;
  reactionRoleRules.set(
    reactionRoleRuleKey(guild.id, messageId, parsedEmoji.key),
    {
      id: Number(rows[0].id),
      guildId: guild.id,
      channelId: selectedChannel.id,
      messageId,
      emojiKey: parsedEmoji.key,
      emojiDisplay: parsedEmoji.display,
      roleIds,
    },
  );
  const link = `https://discord.com/channels/${guild.id}/${selectedChannel.id}/${messageId}`;
  await interaction.editReply({
    content:
      `✅ [対象メッセージ](${link}) の ${parsedEmoji.display} に設定しました。\n` +
      `付与するロール: ${roleIds.map((roleId) => `<@&${roleId}>`).join(" ")}\n` +
      "リアクションを外すと、設定されたロールも外れます。",
    allowedMentions: { parse: [] },
  });
}

async function applyReactionRoleChange(reaction, user, adding) {
  if (user.bot || !reaction.message.guild || isGuildBlocked(reaction.message.guild.id)) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  const emojiKey = getDiscordReactionEmojiKey(reaction.emoji);
  if (!emojiKey) return;
  const guild = reaction.message.guild;
  const rule = reactionRoleRules.get(
    reactionRoleRuleKey(guild.id, reaction.message.id, emojiKey),
  );
  if (!rule || rule.channelId !== reaction.message.channelId) return;

  const member = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return;
  const roles = rule.roleIds
    .map((roleId) => guild.roles.cache.get(roleId))
    .filter((role) => role && !getReactionRoleSafetyError(role, guild, botMember));
  const changedRoleIds = roles
    .filter((role) => adding ? !member.roles.cache.has(role.id) : member.roles.cache.has(role.id))
    .map((role) => role.id);
  if (changedRoleIds.length === 0) return;
  const reason = `NuviloView reaction role · message ${rule.messageId}`;
  if (adding) await member.roles.add(changedRoleIds, reason);
  else await member.roles.remove(changedRoleIds, reason);
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

const moderationActionConfig = {
  ban: {
    actorPermission: PermissionFlagsBits.BanMembers,
    botPermission: PermissionFlagsBits.BanMembers,
    capability: "bannable",
  },
  kick: {
    actorPermission: PermissionFlagsBits.KickMembers,
    botPermission: PermissionFlagsBits.KickMembers,
    capability: "kickable",
  },
  timeout: {
    actorPermission: PermissionFlagsBits.ModerateMembers,
    botPermission: PermissionFlagsBits.ModerateMembers,
    capability: "moderatable",
  },
  untimeout: {
    actorPermission: PermissionFlagsBits.ModerateMembers,
    botPermission: PermissionFlagsBits.ModerateMembers,
    capability: "moderatable",
  },
  unban: {
    actorPermission: PermissionFlagsBits.BanMembers,
    botPermission: PermissionFlagsBits.BanMembers,
  },
  banlist: {
    actorPermission: PermissionFlagsBits.BanMembers,
    botPermission: PermissionFlagsBits.BanMembers,
  },
  clear: {
    actorPermission: PermissionFlagsBits.ManageMessages,
    botPermission: PermissionFlagsBits.ManageMessages,
  },
};

function getInteractionMemberName(interaction) {
  return (
    interaction.member?.displayName ??
    interaction.user.globalName ??
    interaction.user.username
  ).slice(0, 100);
}

function getModerationCooldownSeconds(interaction, action) {
  const key = `${interaction.guildId}:${interaction.user.id}:${action}`;
  const previous = moderationAttempts.get(key) ?? 0;
  const remainingMs = moderationCooldownMs - (Date.now() - previous);
  if (remainingMs > 0) return Math.ceil(remainingMs / 1000);
  moderationAttempts.set(key, Date.now());
  return 0;
}

async function replyModerationError(interaction, message) {
  const content = `❌ ${message}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, embeds: [], allowedMentions: { parse: [] } });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

function normalizePrefixReply(payload) {
  if (typeof payload === "string") {
    return { content: payload, allowedMentions: { parse: [] } };
  }
  const { flags: _flags, ...messagePayload } = payload;
  return {
    ...messagePayload,
    allowedMentions: { parse: [] },
  };
}

function createPrefixModerationContext(message, optionValues) {
  const context = {
    guild: message.guild,
    guildId: message.guild.id,
    channel: message.channel,
    channelId: message.channelId,
    user: message.author,
    member: message.member,
    memberPermissions: message.member?.permissions ?? null,
    sourceMessageId: message.id,
    deferred: false,
    replied: false,
    responseMessage: null,
    inGuild: () => true,
    options: {
      getBoolean: (name) => optionValues[name] ?? null,
      getInteger: (name) => optionValues[name] ?? null,
      getString: (name) => optionValues[name] ?? null,
      getUser: (name) => optionValues[name] ?? null,
    },
    async reply(payload) {
      context.responseMessage = await message.channel.send(
        normalizePrefixReply(payload),
      );
      context.replied = true;
      return context.responseMessage;
    },
    async deferReply() {
      context.deferred = true;
    },
    async editReply(payload) {
      const normalized = normalizePrefixReply(payload);
      if (context.responseMessage?.editable) {
        await context.responseMessage.edit(normalized);
      } else {
        context.responseMessage = await message.channel.send(normalized);
      }
      context.deferred = false;
      context.replied = true;
      return context.responseMessage;
    },
  };
  return context;
}

function createComponentModerationContext(interaction, optionValues) {
  const context = {
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel: interaction.channel,
    channelId: interaction.channelId,
    user: interaction.user,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions,
    sourceMessageId: null,
    deferred: interaction.deferred,
    replied: interaction.replied,
    inGuild: () => interaction.inGuild(),
    options: {
      getBoolean: (name) => optionValues[name] ?? null,
      getInteger: (name) => optionValues[name] ?? null,
      getString: (name) => optionValues[name] ?? null,
      getUser: (name) => optionValues[name] ?? null,
    },
    async reply(payload) {
      const result = await interaction.reply(payload);
      context.replied = true;
      return result;
    },
    async deferReply(payload) {
      const result = await interaction.deferReply(payload);
      context.deferred = true;
      return result;
    },
    async editReply(payload) {
      const result = await interaction.editReply(payload);
      context.deferred = false;
      context.replied = true;
      return result;
    },
  };
  return context;
}

function ignoreSnipeDeletion(messageId) {
  if (!messageId) return;
  ignoredSnipeDeleteIds.add(messageId);
  const cleanupTimer = setTimeout(
    () => ignoredSnipeDeleteIds.delete(messageId),
    10_000,
  );
  cleanupTimer.unref();
}

async function replyWithSecurityUsage(message, commandName, detail = null) {
  const definition = getSecurityCommandDefinition(commandName);
  const content = definition
    ? `${detail ? `❌ ${detail}\n` : ""}使い方: \`${definition.usage}\``
    : "❌ 不明なセキュリティコマンドです。`r?help` で一覧を確認してください。";
  await message.channel.send({ content, allowedMentions: { parse: [] } });
}

async function replyWithEntertainmentUsage(message, commandName, detail = null) {
  const definition = getEntertainmentCommandDefinition(commandName);
  const content = definition
    ? `${detail ? `❌ ${detail}\n` : ""}使い方: \`${definition.usage}\``
    : "❌ 不明な娯楽コマンドです。`zx?help` で一覧を確認してください。";
  await message.channel.send({ content, allowedMentions: { parse: [] } });
}

const securityCommandPresentation = Object.freeze({
  ban: {
    icon: "🔨",
    permission: "BanMembers",
    note: "`--confirm`必須・対象とのロール階層を検証",
  },
  unban: {
    icon: "🔓",
    permission: "BanMembers",
    note: "BAN済みユーザーのDiscord IDを指定",
  },
  kick: {
    icon: "🚪",
    permission: "KickMembers",
    note: "`--confirm`必須・対象とのロール階層を検証",
  },
  timeout: {
    icon: "⏳",
    permission: "ModerateMembers",
    note: "1〜40320分・対象とのロール階層を検証",
  },
  untimeout: {
    icon: "✅",
    permission: "ModerateMembers",
    note: "対象のTimeoutを解除",
  },
  banlist: {
    icon: "📋",
    permission: "BanMembers",
    note: "1ページ10件・最大100件を確認",
  },
  clear: {
    icon: "🧹",
    permission: "ManageMessages",
    note: "`--confirm`必須・ピン留めと14日超の投稿を保護",
  },
  ping: {
    icon: "🏓",
    permission: "不要",
    note: "Discord GatewayとNeonDBの接続を確認",
  },
  perm_check: {
    icon: "🔐",
    permission: "不要",
    note: "実行者とBotの権限を機能別に診断",
  },
});

async function handleSecurityHelpCommand(message, args) {
  if (args.length > 1) {
    await replyWithSecurityUsage(
      message,
      "help",
      "確認するコマンド名は1つだけ指定してください。",
    );
    return;
  }
  const requestedName = args[0]?.toLowerCase();
  if (requestedName) {
    const definition = getSecurityCommandDefinition(requestedName);
    if (!definition) {
      await replyWithSecurityUsage(message, requestedName);
      return;
    }
    const presentation = securityCommandPresentation[definition.name] ?? {
      icon: "🛡️",
      permission: "コマンドごとに判定",
      note: "実行時に権限を検証",
    };
    const container = new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## ${presentation.icon} ${definition.usage}\n` +
            `-# ${formatGuildName(message.guild.name)} · NuviloChan Security Center`,
        ),
        new TextDisplayBuilder().setContent(
          [
            definition.description,
            "",
            `**使い方:** \`${definition.usage}\``,
            `**必要権限:** \`${presentation.permission}\``,
            `**安全機構:** ${presentation.note}`,
          ].join("\n"),
        ),
        new TextDisplayBuilder().setContent(
          "-# 権限を確認: r?perm_check · 一覧へ戻る: r?help",
        ),
      );
    await message.channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const commandList = securityCommandDefinitions
    .filter(
      (definition) =>
        definition.name !== "help" && definition.name !== "perm_check",
    )
    .map((definition) => {
      const presentation = securityCommandPresentation[definition.name] ?? {
        icon: "🛡️",
        permission: "コマンドごとに判定",
        note: "実行時に権限を検証",
      };
      return (
        `${presentation.icon} **\`${definition.usage}\`**\n` +
        `${definition.description}\n` +
        `-# 必要権限: ${presentation.permission} · ${presentation.note}`
      );
    })
    .join("\n\n");
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## 🛡️ NuviloChan Security Center\n" +
          `-# ${formatGuildName(message.guild.name)} · r? Commands`,
      ),
      new TextDisplayBuilder().setContent(
        "サーバーを安全に運営するためのモデレーション・診断コマンドです。\n" +
          "`r?help <command>`で詳しい使い方、`r?perm_check`で現在利用できる機能を確認できます。",
      ),
      new TextDisplayBuilder().setContent(
        `### 🚨 自動スパム検知 — ${spamProtectionEnabled ? "稼働中" : "停止中"}\n` +
          `${spamWindowMs / 1_000}秒以内に同一ユーザーまたはBotが${spamMessageLimit}件送信すると、` +
          `${spamTimeoutMinutes}分タイムアウトを試行します。\n` +
          "-# 検知カードからTimeout解除・Kick・BANを選択でき、成功後はカードを自動削除します。",
      ),
      new TextDisplayBuilder().setContent(
        "### 🔐 権限・実行可否チェック\n" +
          "**`r?perm_check`** — 実行者とBotの権限を照合し、利用可能な機能を一覧表示します。",
      ),
      new TextDisplayBuilder().setContent(
        `### 🧰 セキュリティコマンド\n${commandList}`,
      ),
      new TextDisplayBuilder().setContent(
        "### 🔒 権限と安全機構\n" +
          "実行者権限・Bot権限・対象とのロール階層を毎回検証します。BAN・Kick・Clearは`--confirm`必須です。\n" +
          "-# 理由は3〜300文字 · 件数制限・クールダウン・監査ログあり · コマンド本文は分析データへ保存しません。",
      ),
    );
  await message.channel.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function handlePrefixMemberModeration(message, invocation) {
  const { confirmed, args } = extractConfirmation(invocation.args);
  const targetId = parseDiscordTargetId(args[0]);
  if (!targetId) {
    await replyWithSecurityUsage(
      message,
      invocation.name,
      "対象メンバーをメンションまたはDiscord IDで指定してください。",
    );
    return;
  }

  let targetMember;
  try {
    targetMember = await message.guild.members.fetch(targetId);
  } catch {
    await replyWithSecurityUsage(
      message,
      invocation.name,
      "対象メンバーをこのサーバーで確認できません。",
    );
    return;
  }

  let reasonStart = 1;
  let minutes = null;
  if (invocation.name === "timeout") {
    minutes = Number(args[1]);
    if (!Number.isInteger(minutes)) {
      await replyWithSecurityUsage(
        message,
        invocation.name,
        "タイムアウト時間を分単位で指定してください。",
      );
      return;
    }
    reasonStart = 2;
  }

  const reason = args.slice(reasonStart).join(" ").trim();
  const context = createPrefixModerationContext(message, {
    user: targetMember.user,
    minutes,
    reason,
    confirm: confirmed,
  });
  await handleMemberModerationCommand(context, invocation.name);
}

async function handlePrefixUnban(message, invocation) {
  const targetId = parseDiscordTargetId(invocation.args[0]);
  if (!targetId) {
    await replyWithSecurityUsage(
      message,
      "unban",
      "BANを解除するユーザーのDiscord IDを指定してください。",
    );
    return;
  }
  const reason = invocation.args.slice(1).join(" ").trim();
  const context = createPrefixModerationContext(message, {
    user_id: targetId,
    reason,
  });
  await handleUnbanCommand(context);
}

async function handlePrefixBanlist(message, invocation) {
  const page = invocation.args[0] ? Number(invocation.args[0]) : 1;
  if (!Number.isInteger(page) || page < 1 || invocation.args.length > 1) {
    await replyWithSecurityUsage(message, "banlist", "ページ番号が正しくありません。");
    return;
  }
  const context = createPrefixModerationContext(message, { page });
  await handleBanlistCommand(context);
}

async function handlePrefixClear(message, invocation) {
  const { confirmed, args } = extractConfirmation(invocation.args);
  const amount = Number(args[0]);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    await replyWithSecurityUsage(
      message,
      "clear",
      "削除件数は1〜100で指定してください。",
    );
    return;
  }
  const reason = args.slice(1).join(" ").trim();
  const context = createPrefixModerationContext(message, {
    amount,
    reason,
    confirm: confirmed,
  });
  await handleClearCommand(context);
}

function getSnipeChannelKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function getLiveDeletedMessageSnipes(key, now = Date.now()) {
  const stored = deletedMessageSnipes.get(key);
  const records = Array.isArray(stored) ? stored : stored ? [stored] : [];
  const liveRecords = limitSnipeHistory(
    records.filter(
      (record) =>
        record &&
        Number.isFinite(record.deletedAt) &&
        now - record.deletedAt <= SNIPE_RETENTION_MS,
    ),
  );
  if (liveRecords.length > 0) {
    deletedMessageSnipes.set(key, liveRecords);
  } else {
    deletedMessageSnipes.delete(key);
    const cleanupTimer = snipeHistoryCleanupTimers.get(key);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    snipeHistoryCleanupTimers.delete(key);
  }
  return liveRecords;
}

function scheduleSnipeHistoryCleanup(key) {
  const previousTimer = snipeHistoryCleanupTimers.get(key);
  if (previousTimer) clearTimeout(previousTimer);
  const records = getLiveDeletedMessageSnipes(key);
  if (records.length === 0) return;
  let earliestExpiry = Number.POSITIVE_INFINITY;
  for (const record of records) {
    earliestExpiry = Math.min(
      earliestExpiry,
      record.deletedAt + SNIPE_RETENTION_MS,
    );
  }
  const cleanupTimer = setTimeout(() => {
    snipeHistoryCleanupTimers.delete(key);
    const remainingRecords = getLiveDeletedMessageSnipes(key);
    if (remainingRecords.length > 0) scheduleSnipeHistoryCleanup(key);
  }, getSnipeCleanupDelay(earliestExpiry));
  cleanupTimer.unref();
  snipeHistoryCleanupTimers.set(key, cleanupTimer);
}

function formatSnipeIdentity(userId, fallbackName = "不明なユーザー") {
  const normalizedId = String(userId ?? "").trim();
  if (/^\d{17,20}$/.test(normalizedId)) return `<@${normalizedId}>`;
  return escapeSnipeText(fallbackName, 80);
}

function buildSnipeEmbed(session) {
  const deleted = session.deletedMessages[session.currentIndex] ?? null;
  if (deleted) {
    const body = deleted.content
      ? escapeSnipeText(deleted.content, 850)
      : "（本文なし・添付またはEmbedのみ）";
    const details = deleted.deletedById
      ? [`-# 削除者: ${formatSnipeIdentity(deleted.deletedById, deleted.deletedByName)}`]
      : [];
    return new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`削除されたメッセージ (${session.currentIndex + 1}個前)`)
      .setDescription(
        [
          `${formatSnipeIdentity(deleted.authorId, deleted.authorName)} ` +
            `(<t:${Math.floor(deleted.deletedAt / 1_000)}:R>)`,
          `\`\`\`\n${body}\n\`\`\``,
          ...details,
        ].join("\n"),
      );
  }

  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("削除されたメッセージ")
    .setDescription("このチャンネルには確認できる削除履歴がありません。");
}

function buildSnipeComponents(session) {
  const lastIndex = session.deletedMessages.length - 1;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(createSnipePageCustomId("previous"))
        .setEmoji("◀️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(session.currentIndex <= 0),
      new ButtonBuilder()
        .setCustomId(createSnipePageCustomId("next"))
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(lastIndex < 1 || session.currentIndex >= lastIndex),
      new ButtonBuilder()
        .setCustomId(createSnipeDeleteCustomId(session.executorId))
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function createSnipeSession({ guildId, channelId, executorId }) {
  const key = getSnipeChannelKey(guildId, channelId);
  const deletedMessages = getLiveDeletedMessageSnipes(key);

  return {
    executorId,
    guildId,
    channelId,
    deletedMessages,
    currentIndex: 0,
    expiresAt: Date.now() + SNIPE_RESULT_SESSION_MS,
  };
}

function registerSnipeResultSession(response, session) {
  snipeResultSessions.set(response.id, session);
  const cleanupTimer = setTimeout(
    () => snipeResultSessions.delete(response.id),
    SNIPE_RESULT_SESSION_MS,
  );
  cleanupTimer.unref();
}

async function handlePrefixSnipe(message, invocation) {
  if (invocation.args.length > 0) {
    await replyWithEntertainmentUsage(message, "snipe", "zx?snipeに引数は必要ありません。");
    return;
  }

  const session = await createSnipeSession({
    guildId: message.guild.id,
    channelId: message.channelId,
    executorId: message.author.id,
  });
  const response = await message.channel.send({
    embeds: [buildSnipeEmbed(session)],
    components: buildSnipeComponents(session),
    allowedMentions: { parse: [] },
  });
  registerSnipeResultSession(response, session);
}

async function handleSnipePageComponent(interaction, parsed) {
  const session = snipeResultSessions.get(interaction.message.id);
  if (
    !session ||
    session.expiresAt < Date.now() ||
    session.guildId !== interaction.guildId ||
    session.channelId !== interaction.channelId
  ) {
    snipeResultSessions.delete(interaction.message.id);
    await interaction.reply({
      content: "❌ このSnipe表示は期限切れです。zx?snipeをもう一度実行してください。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const previousIndex = session.currentIndex;
  if (parsed.direction === "previous") {
    session.currentIndex = Math.max(0, session.currentIndex - 1);
  } else {
    session.currentIndex = Math.min(
      Math.max(0, session.deletedMessages.length - 1),
      session.currentIndex + 1,
    );
  }
  if (previousIndex === session.currentIndex) {
    await interaction.deferUpdate();
    return;
  }
  await interaction.update({
    embeds: [buildSnipeEmbed(session)],
    components: buildSnipeComponents(session),
    allowedMentions: { parse: [] },
  });
}

async function handleSnipeDeleteComponent(interaction) {
  const parsed = parseSnipeDeleteCustomId(interaction.customId);
  if (!parsed || !interaction.inGuild()) {
    await interaction.reply({
      content: "❌ このSnipe削除ボタンは無効です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const allowed = canDeleteSnipeResult({
    userId: interaction.user.id,
    executorId: parsed.executorId,
    guildOwnerId: interaction.guild.ownerId,
    isAdministrator: Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
    ),
  });
  if (!allowed) {
    await interaction.reply({
      content: "❌ この結果を削除できるのは、zx?snipeの実行者またはサーバー管理者だけです。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.deferUpdate();
  snipeResultSessions.delete(interaction.message.id);
  ignoreSnipeDeletion(interaction.message.id);
  await interaction.message.delete().catch(async (error) => {
    console.error("Failed to delete Snipe result:", error);
    await interaction.followUp({
      content: "❌ Snipe結果を削除できませんでした。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  });
}

async function handleSnipeComponent(interaction) {
  const page = parseSnipePageCustomId(interaction.customId);
  if (page) {
    await handleSnipePageComponent(interaction, page);
    return;
  }
  await handleSnipeDeleteComponent(interaction);
}

async function handlePrefixPing(message, invocation) {
  if (invocation.args.length > 0) {
    await replyWithSecurityUsage(message, "ping", "r?pingに引数は必要ありません。");
    return;
  }

  const context = createPrefixModerationContext(message, {});
  const remainingSeconds = getModerationCooldownSeconds(context, "ping");
  if (remainingSeconds > 0) {
    await replyModerationError(
      context,
      `連続実行を防ぐため、${remainingSeconds}秒後にもう一度お試しください。`,
    );
    return;
  }

  const databaseStartedAt = Date.now();
  let databaseConnected = false;
  try {
    await sql`SELECT 1 AS "connected"`;
    databaseConnected = true;
  } catch (error) {
    console.warn("Ping command could not reach NeonDB:", safeErrorText(error));
  }
  const databaseLatencyMs = Date.now() - databaseStartedAt;
  const gatewayConnected = client.isReady();
  const gatewayLatencyMs =
    Number.isFinite(client.ws.ping) && client.ws.ping >= 0
      ? Math.round(client.ws.ping)
      : Math.max(0, Date.now() - message.createdTimestamp);

  await message.channel.send({
    content:
      `pong!🏓 ${gatewayLatencyMs}ms\n` +
      `-# 接続先: Discord Gateway（${gatewayConnected ? "接続済み" : "未接続"}）・` +
      `NeonDB（${databaseConnected ? `接続済み / ${databaseLatencyMs}ms` : "未接続"}）`,
    allowedMentions: { parse: [] },
  });
}

function hasNamedPermission(permissions, permissionName) {
  const permission = PermissionFlagsBits[permissionName];
  return Boolean(permission && permissions?.has(permission));
}

async function handlePrefixPermissionCheck(message, invocation) {
  if (invocation.args.length > 0) {
    await replyWithSecurityUsage(
      message,
      "perm_check",
      "r?perm_checkに引数は必要ありません。",
    );
    return;
  }

  const context = createPrefixModerationContext(message, {});
  const remainingSeconds = getModerationCooldownSeconds(context, "perm_check");
  if (remainingSeconds > 0) {
    await replyModerationError(
      context,
      `連続実行を防ぐため、${remainingSeconds}秒後にもう一度お試しください。`,
    );
    return;
  }

  const [actorMember, botMember] = await Promise.all([
    message.member ?? message.guild.members.fetch(message.author.id),
    message.guild.members.me ?? message.guild.members.fetchMe(),
  ]);
  const channelPermissions =
    message.channel.permissionsFor?.(botMember) ?? botMember.permissions;
  const actorPermissions = securityPermissionCheckDefinitions
    .filter((definition) =>
      hasNamedPermission(actorMember.permissions, definition.actorPermission),
    )
    .map((definition) => definition.actorPermission);
  const botPermissions = securityPermissionCheckDefinitions
    .filter((definition) => {
      const permissions =
        definition.key === "clear"
          ? channelPermissions
          : botMember.permissions;
      return hasNamedPermission(permissions, definition.botPermission);
    })
    .map((definition) => definition.botPermission);
  const actorIsOwner = message.author.id === message.guild.ownerId;
  const actorIsAdministrator = actorMember.permissions.has(
    PermissionFlagsBits.Administrator,
  );
  const checks = evaluateSecurityPermissionChecks({
    actorIsOwner,
    actorIsAdministrator,
    actorPermissions,
    botPermissions,
  });
  const availableCount = checks.filter((check) => check.available).length;
  const actorLabel = actorIsOwner
    ? "サーバー所有者"
    : actorIsAdministrator
      ? "Administrator"
      : "個別権限";
  const sendPermission = message.channel.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  const commonChecks = [
    {
      label: "チャンネルを表示",
      available: channelPermissions.has(PermissionFlagsBits.ViewChannel),
      permission: "ViewChannel",
    },
    {
      label: "メッセージを送信",
      available: channelPermissions.has(sendPermission),
      permission: message.channel.isThread?.()
        ? "SendMessagesInThreads"
        : "SendMessages",
    },
  ];

  const accentColor =
      availableCount === checks.length
        ? 0x57f287
        : availableCount > 0
          ? 0xfee75c
          : 0xed4245;
  const capabilityText = checks
    .map(
      (check) =>
        `### ${check.available ? "✅" : "❌"} ${check.label}\n` +
        `実行者: ${check.actorAllowed ? "✅ 利用可能" : `❌ \`${check.actorPermission}\`が必要`}\n` +
        `Bot: ${check.botAllowed ? "✅ 権限あり" : `❌ \`${check.botPermission}\`が必要`}\n` +
        `-# ${check.commands}`,
    )
    .join("\n\n");
  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## 🔐 Security Permission Check\n" +
          `-# ${formatGuildName(message.guild.name)} · NuviloChan Security Diagnostics`,
      ),
      new TextDisplayBuilder().setContent(
        [
        `<@${message.author.id}>のセキュリティ機能を診断しました。`,
        `**判定方式:** ${actorLabel} / Bot実効権限`,
        `**利用可能:** ${availableCount}/${checks.length}カテゴリ`,
        ].join("\n"),
      ),
      new TextDisplayBuilder().setContent(capabilityText),
      new TextDisplayBuilder().setContent(
        "### 📡 共通チャンネル権限\n" +
          commonChecks
          .map(
            (check) =>
              `${check.available ? "✅" : "❌"} ${check.label} — \`${check.permission}\``,
          )
          .join("\n"),
      ),
      new TextDisplayBuilder().setContent(
        "### 🧱 実行時に再確認される項目\n" +
          "対象メンバーとのロール階層、サーバー所有者・Bot・自分自身などの保護対象、確認フラグ、件数上限、クールダウンを実行時に再検証します。\n" +
          "-# 豪華表示はComponents V2を使用するため、EmbedLinks権限は不要です。",
      ),
    );
  await message.channel.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

function getEntertainmentCooldownSeconds(guildId, userId, action) {
  const key = `${guildId}:${userId}:${action}`;
  const now = Date.now();
  const activeUntil = entertainmentAttempts.get(key) ?? 0;
  if (activeUntil > now) return Math.ceil((activeUntil - now) / 1_000);

  const expiresAt = now + entertainmentCooldownMs;
  entertainmentAttempts.set(key, expiresAt);
  const cleanupTimer = setTimeout(() => {
    if (entertainmentAttempts.get(key) === expiresAt) {
      entertainmentAttempts.delete(key);
    }
  }, entertainmentCooldownMs + 100);
  cleanupTimer.unref();
  return 0;
}

function buildDiceResultComponents({ executorId, count, sides, notation }, result) {
  const rerollButton = new ButtonBuilder()
    .setCustomId(createDiceRollCustomId({ count, sides }))
    .setLabel(`${notation}をロール`)
    .setStyle(ButtonStyle.Primary);
  const resultSection = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎲 <@${executorId}>\n**${notation}をロールして${result.total}が出た！**`,
      ),
    )
    .setButtonAccessory(rerollButton);
  const rolls = result.rolls.map((value) => `🎲 ${value}`).join("　");
  return [
    new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addSectionComponents(resultSection)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(rolls)),
  ];
}

function buildDiscordNativeDiceLaunch({ guildId, channelId, dice }) {
  const url = createDiscordNativeDiceUrl({
    guildId,
    channelId,
    count: dice.count,
    sides: dice.sides,
  });
  return {
    content:
      `🎲 [${dice.notation}をDiscord標準でロール](${url})\n` +
      "-# リンクまたはボタンを押すと、結果があなた本人の投稿として送信されます。",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`${dice.notation}をロール`)
          .setStyle(ButtonStyle.Link)
          .setURL(url),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function buildEntertainmentHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎮 娯楽コマンド")
    .setDescription(
      "`zx?dice`・`zx?snipe`と`/zx`は全メンバーが利用できます。",
    )
    .addFields(
      entertainmentCommandDefinitions.map((definition) => ({
        name: definition.usage,
        value: definition.description,
        inline: false,
      })),
    )
    .setFooter({
      text: "詳細: zx?help <command> または /zx help · 再ロールボタンは誰でも使えます。",
    });
}

async function handleEntertainmentHelpCommand(message, args) {
  if (args.length > 1) {
    await message.channel.send({
      content: "❌ 使い方: `zx?help [command]`",
      allowedMentions: { parse: [] },
    });
    return;
  }

  const requestedName = args[0]?.toLowerCase();
  if (requestedName) {
    const definition = getEntertainmentCommandDefinition(requestedName);
    if (!definition) {
      await message.channel.send({
        content: "❌ 不明な娯楽コマンドです。`zx?help` で一覧を確認してください。",
        allowedMentions: { parse: [] },
      });
      return;
    }
    const details =
      definition.name === "dice"
        ? "\n`10d` は10個の10面ダイス、`2d6` は2個の6面ダイスです。1回1〜50個、2〜1000面まで指定できます。"
        : "";
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🎮 ${definition.usage}`)
          .setDescription(`${definition.description}${details}`),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await message.channel.send({
    embeds: [buildEntertainmentHelpEmbed()],
    allowedMentions: { parse: [] },
  });
}

async function handlePrefixDice(message, invocation) {
  const dice = parseDiceNotation(invocation.argumentText);
  if (!dice) {
    await message.channel.send({
      content:
        "❌ ダイス指定が正しくありません。使い方: `zx?dice [10d | 2d6]`\n" +
        "-# 1〜50個、2〜1000面まで指定できます。",
      allowedMentions: { parse: [] },
    });
    return;
  }
  const remainingSeconds = getEntertainmentCooldownSeconds(
    message.guild.id,
    message.author.id,
    "dice",
  );
  if (remainingSeconds > 0) {
    await message.channel.send({
      content: `⏳ ${remainingSeconds}秒後にもう一度ロールできます。`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (canUseDiscordNativeDice(dice)) {
    await message.channel.send(
      buildDiscordNativeDiceLaunch({
        guildId: message.guild.id,
        channelId: message.channelId,
        dice,
      }),
    );
    return;
  }

  const result = rollDice(dice, randomInt);
  await message.channel.send({
    components: buildDiceResultComponents(
      { executorId: message.author.id, ...dice },
      result,
    ),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function handleZxSlashDice(interaction) {
  const dice = parseDiceNotation(interaction.options.getString("dice", true));
  if (!dice) {
    await interaction.reply({
      content:
        "❌ ダイス指定が正しくありません。`10d` または `2d6` の形式で入力してください。\n" +
        "-# 1〜50個、2〜1000面まで指定できます。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  const remainingSeconds = getEntertainmentCooldownSeconds(
    interaction.guildId,
    interaction.user.id,
    "dice",
  );
  if (remainingSeconds > 0) {
    await interaction.reply({
      content: `⏳ ${remainingSeconds}秒後にもう一度ロールできます。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (canUseDiscordNativeDice(dice)) {
    await interaction.reply({
      ...buildDiscordNativeDiceLaunch({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        dice,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = rollDice(dice, randomInt);
  await interaction.reply({
    components: buildDiceResultComponents(
      { executorId: interaction.user.id, ...dice },
      result,
    ),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function handleZxSlashSnipe(interaction) {
  const session = await createSnipeSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    executorId: interaction.user.id,
  });
  await interaction.reply({
    embeds: [buildSnipeEmbed(session)],
    components: buildSnipeComponents(session),
    allowedMentions: { parse: [] },
  });
  const response = await interaction.fetchReply();
  registerSnipeResultSession(response, session);
}

async function handleZxSlashCommand(interaction) {
  if (!interaction.inGuild() || !interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: "❌ このコマンドはサーバー内でのみ利用できます。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (isGuildBlocked(interaction.guildId)) {
    await interaction.reply({
      content: "❌ このサーバーではBot機能が停止されています。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "help") {
    await interaction.reply({
      embeds: [buildEntertainmentHelpEmbed()],
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (subcommand === "dice") {
    await handleZxSlashDice(interaction);
    return;
  }
  if (subcommand === "snipe") {
    await handleZxSlashSnipe(interaction);
  }
}

async function handlePrefixEntertainmentCommand(message, invocation) {
  if (!invocation.definition) {
    await message.channel.send({
      content: "❌ 不明な娯楽コマンドです。`zx?help` で一覧を確認してください。",
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (invocation.name === "help") {
    await handleEntertainmentHelpCommand(message, invocation.args);
    return;
  }
  if (invocation.name === "dice") {
    await handlePrefixDice(message, invocation);
    return;
  }
  if (invocation.name === "snipe") {
    await handlePrefixSnipe(message, invocation);
  }
}

async function handleDiceRollComponent(interaction) {
  const parsed = parseDiceRollCustomId(interaction.customId);
  if (!parsed || !interaction.inGuild()) {
    await interaction.reply({
      content: "❌ このダイスボタンは無効です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const remainingSeconds = getEntertainmentCooldownSeconds(
    interaction.guildId,
    interaction.user.id,
    "dice",
  );
  if (remainingSeconds > 0) {
    await interaction.reply({
      content: `⏳ ${remainingSeconds}秒後にもう一度ロールできます。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const dice = {
    count: parsed.count,
    sides: parsed.sides,
    notation: formatDiceNotation(parsed.count, parsed.sides),
  };
  const result = rollDice(dice, randomInt);
  await interaction.reply({
    components: buildDiceResultComponents(
      { executorId: interaction.user.id, ...dice },
      result,
    ),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function handlePrefixSecurityCommand(message, invocation) {
  if (!invocation.definition) {
    await replyWithSecurityUsage(message, invocation.name);
    return;
  }
  if (invocation.name === "help") {
    await handleSecurityHelpCommand(message, invocation.args);
    return;
  }
  if (["ban", "kick", "timeout", "untimeout"].includes(invocation.name)) {
    await handlePrefixMemberModeration(message, invocation);
    return;
  }
  if (invocation.name === "unban") {
    await handlePrefixUnban(message, invocation);
    return;
  }
  if (invocation.name === "banlist") {
    await handlePrefixBanlist(message, invocation);
    return;
  }
  if (invocation.name === "clear") {
    await handlePrefixClear(message, invocation);
    return;
  }
  if (invocation.name === "ping") {
    await handlePrefixPing(message, invocation);
    return;
  }
  if (invocation.name === "perm_check") {
    await handlePrefixPermissionCheck(message, invocation);
  }
}

function getSpamProtectedReason(member) {
  const protectedPermissions = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
  ];
  return getAutomaticSpamProtectionBlockReason({
    isBot: member.user.bot,
    isOwner: member.id === member.guild.ownerId,
    hasModerationPermission: protectedPermissions.some((permission) =>
      member.permissions.has(permission),
    ),
  });
}

function canBotSendToChannel(channel, botMember) {
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") return false;
  const permissions = channel.permissionsFor?.(botMember);
  const sendPermission = channel.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(sendPermission),
  );
}

function findSpamAlertChannel(message, botMember) {
  const candidates = [
    message.channel,
    message.guild.systemChannel,
    ...message.guild.channels.cache
      .filter((channel) => /(?:mod|moderation|log|監査|管理)/i.test(channel.name ?? ""))
      .values(),
    ...message.guild.channels.cache.values(),
  ];
  const seen = new Set();
  return (
    candidates.find((channel) => {
      if (!channel || seen.has(channel.id)) return false;
      seen.add(channel.id);
      return canBotSendToChannel(channel, botMember);
    }) ?? null
  );
}

function createSpamActionRow(detectionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        createSpamActionCustomId({
          stage: "execute",
          action: "untimeout",
          detectionId,
        }),
      )
      .setLabel("TO解除")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(
        createSpamActionCustomId({
          stage: "confirm",
          action: "kick",
          detectionId,
        }),
      )
      .setLabel("Kick")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        createSpamActionCustomId({
          stage: "confirm",
          action: "ban",
          detectionId,
        }),
      )
      .setLabel("BAN")
      .setStyle(ButtonStyle.Danger),
  );
}

async function sendSpamDetectionAlert(message, {
  auditId,
  targetMember,
  detectedCount,
  actionResult,
  protectedReason = null,
}) {
  const botMember =
    message.guild.members.me ?? (await message.guild.members.fetchMe());
  const alertChannel = findSpamAlertChannel(message, botMember);
  if (!alertChannel) {
    console.warn(
      `[spam-protection] No sendable alert channel in Guild ${message.guild.id}; audit ${auditId}`,
    );
    return;
  }

  const targetName = formatGuildName(
    targetMember.displayName ??
      targetMember.user.globalName ??
      targetMember.user.username,
  );
  const content =
    `🚨 **スパムを検知しました**\n` +
    `対象: **${targetName}**（\`${targetMember.id}\`）\n` +
    `検知条件: ${(spamWindowMs / 1_000).toLocaleString("ja-JP")}秒以内に` +
    `${detectedCount.toLocaleString("ja-JP")}件\n` +
    `自動対応: ${actionResult}` +
    (protectedReason ? `\n保護理由: ${protectedReason}` : "") +
    `\n-# 所有者・Administrator・対応権限を持つ運営者が操作できます · 監査ID: ${auditId}`;
  const alertMessage = await alertChannel.send({
    content,
    components: protectedReason ? [] : [createSpamActionRow(auditId)],
    allowedMentions: { parse: [] },
  });
  spamAlertMessages.set(auditId, {
    channelId: alertMessage.channelId,
    messageId: alertMessage.id,
  });
  const cleanupTimer = setTimeout(
    () => spamAlertMessages.delete(auditId),
    24 * 60 * 60 * 1_000,
  );
  cleanupTimer.unref();
}

async function handleSpamDetection(message, detection) {
  let targetMember;
  try {
    targetMember =
      message.member ?? (await message.guild.members.fetch(message.author.id));
  } catch (error) {
    console.warn("Spam target could not be fetched:", safeErrorText(error));
    return;
  }

  const botMember =
    message.guild.members.me ?? (await message.guild.members.fetchMe());
  const context = {
    guild: message.guild,
    guildId: message.guild.id,
    user: client.user,
    member: botMember,
  };
  const reason =
    `自動スパム検知: ${spamWindowMs / 1_000}秒以内に` +
    `${detection.count}件のメッセージ`;
  let auditId;
  try {
    auditId = await startModerationAudit(context, {
      action: "spam_timeout",
      targetId: targetMember.id,
      targetName: (
        targetMember.displayName ??
        targetMember.user.globalName ??
        targetMember.user.username
      ).slice(0, 100),
      channelId: message.channelId,
      reason,
      requestedCount: detection.count,
    });
  } catch (error) {
    console.error("Failed to start spam detection audit:", error);
    return;
  }

  const protectedReason = getSpamProtectedReason(targetMember);
  if (protectedReason) {
    await finishModerationAudit(auditId, {
      status: "success",
      affectedCount: 0,
    });
    await sendSpamDetectionAlert(message, {
      auditId,
      targetMember,
      detectedCount: detection.count,
      actionResult: "保護対象のため自動タイムアウトなし",
      protectedReason,
    }).catch((error) =>
      console.error("Failed to send protected spam alert:", error),
    );
    return;
  }

  const canTimeout =
    botMember.permissions.has(PermissionFlagsBits.ModerateMembers) &&
    targetMember.moderatable;
  if (!canTimeout) {
    const permissionError = Object.assign(
      new Error("Bot lacks permission or role hierarchy for automatic timeout."),
      { code: "AUTO_TIMEOUT_UNAVAILABLE" },
    );
    await finishModerationAudit(auditId, {
      status: "failed",
      affectedCount: 0,
      error: permissionError,
    });
    await sendSpamDetectionAlert(message, {
      auditId,
      targetMember,
      detectedCount: detection.count,
      actionResult: "Bot権限またはロール階層不足のためタイムアウト失敗",
    }).catch((error) => console.error("Failed to send spam alert:", error));
    return;
  }

  let actionResult;
  try {
    if (
      targetMember.communicationDisabledUntilTimestamp &&
      targetMember.communicationDisabledUntilTimestamp > Date.now()
    ) {
      actionResult = "すでにタイムアウト中";
      await finishModerationAudit(auditId, {
        status: "success",
        affectedCount: 0,
      });
    } else {
      await targetMember.timeout(
        spamTimeoutMinutes * 60_000,
        moderationAuditReason(reason, context, auditId),
      );
      actionResult = `${spamTimeoutMinutes.toLocaleString("ja-JP")}分間のタイムアウト`;
      await finishModerationAudit(auditId, {
        status: "success",
        affectedCount: 1,
      });
    }
  } catch (error) {
    console.error("Automatic spam timeout failed:", error);
    actionResult = "Discord APIエラーのためタイムアウト失敗";
    await finishModerationAudit(auditId, {
      status: "failed",
      affectedCount: 0,
      error,
    }).catch((auditError) =>
      console.error("Failed to finish spam audit:", auditError),
    );
  }

  await sendSpamDetectionAlert(message, {
    auditId,
    targetMember,
    detectedCount: detection.count,
    actionResult,
  }).catch((error) => console.error("Failed to send spam alert:", error));
}

async function replySpamComponentError(interaction, message) {
  const payload = {
    content: `❌ ${message}`,
    flags: MessageFlags.Ephemeral,
    components: [],
    allowedMentions: { parse: [] },
  };
  if (interaction.deferred || interaction.replied) {
    const { flags: _flags, ...editPayload } = payload;
    await interaction.editReply(editPayload);
  } else {
    await interaction.reply(payload);
  }
}

async function getSpamDetectionForComponent(interaction, detectionId) {
  if (!/^[0-9a-f-]{36}$/i.test(detectionId)) return null;
  const rows = await sql`
    SELECT
      "id", "guildId", "targetId", "targetName", "createdAt"
    FROM "bot_moderation_audit"
    WHERE
      "id" = ${detectionId}
      AND "action" = 'spam_timeout'
    LIMIT 1
  `;
  const detection = rows[0] ?? null;
  if (
    !detection ||
    detection.guildId !== interaction.guildId ||
    !detection.targetId ||
    Date.now() - new Date(detection.createdAt).getTime() > 24 * 60 * 60 * 1_000
  ) {
    return null;
  }
  return detection;
}

async function deleteSpamDetectionAlert({
  interaction,
  detectionId,
  alertChannelId,
  alertMessageId,
}) {
  const cachedReference = spamAlertMessages.get(detectionId);
  const channelId = alertChannelId ?? cachedReference?.channelId;
  const messageId = alertMessageId ?? cachedReference?.messageId;
  if (!channelId || !messageId) return false;

  try {
    const channel =
      interaction.guild.channels.cache.get(channelId) ??
      (await interaction.guild.channels.fetch(channelId));
    if (
      !channel ||
      channel.guildId !== interaction.guildId ||
      !channel.isTextBased?.() ||
      !channel.messages?.fetch
    ) {
      return false;
    }
    const alertMessage =
      interaction.message.id === messageId
        ? interaction.message
        : await channel.messages.fetch(messageId);
    if (
      alertMessage.author.id !== client.user.id ||
      !alertMessage.content.includes(detectionId)
    ) {
      console.warn(
        `[spam-protection] Refused to delete an unverified alert message ${messageId}.`,
      );
      return false;
    }
    ignoreSnipeDeletion(alertMessage.id);
    await alertMessage.delete();
    spamAlertMessages.delete(detectionId);
    return true;
  } catch (error) {
    if (error?.code === 10008) {
      spamAlertMessages.delete(detectionId);
      return true;
    }
    console.error("Failed to delete resolved spam detection alert:", error);
    return false;
  }
}

async function handleSpamActionComponent(interaction) {
  const component = parseSpamActionCustomId(interaction.customId);
  if (!component) {
    await replySpamComponentError(interaction, "操作ボタンが正しくありません。");
    return;
  }
  const {
    stage,
    action,
    detectionId,
    alertChannelId: encodedAlertChannelId,
    alertMessageId: encodedAlertMessageId,
  } = component;

  let detection;
  try {
    detection = await getSpamDetectionForComponent(interaction, detectionId);
  } catch (error) {
    console.error("Failed to load spam detection:", error);
    await replySpamComponentError(interaction, "検知記録を確認できませんでした。");
    return;
  }
  if (!detection) {
    await replySpamComponentError(
      interaction,
      "この検知操作は期限切れ、または別サーバーのものです。",
    );
    return;
  }

  const config = moderationActionConfig[action];
  const actorCanManageAction = canManageSpamAction({
    isOwner: interaction.user.id === interaction.guild.ownerId,
    isAdministrator: Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
    ),
    hasRequiredPermission: Boolean(
      interaction.memberPermissions?.has(config.actorPermission),
    ),
  });
  if (!actorCanManageAction) {
    await replySpamComponentError(
      interaction,
      "サーバー所有者・Administrator・対応するモデレーション権限を持つメンバーだけが操作できます。",
    );
    return;
  }

  if (stage === "cancel") {
    await interaction.update({
      content: "操作をキャンセルしました。",
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (stage === "confirm") {
    const label = action === "ban" ? "BAN" : "Kick";
    const alertChannelId = interaction.channelId;
    const alertMessageId = interaction.message.id;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          createSpamActionCustomId({
            stage: "execute",
            action,
            detectionId,
            alertChannelId,
            alertMessageId,
          }),
        )
        .setLabel(`${label}を実行`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          createSpamActionCustomId({
            stage: "cancel",
            action,
            detectionId,
            alertChannelId,
            alertMessageId,
          }),
        )
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content:
        `⚠️ **${formatGuildName(detection.targetName ?? detection.targetId)}** ` +
        `（\`${detection.targetId}\`）を${label}しますか？`,
      components: [row],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const lockKey = `${detectionId}:${action}`;
  if (spamActionLocks.has(lockKey)) {
    await replySpamComponentError(interaction, "この操作は現在実行中です。");
    return;
  }
  spamActionLocks.add(lockKey);
  try {
    let targetMember;
    try {
      targetMember = await interaction.guild.members.fetch(detection.targetId);
    } catch {
      await replySpamComponentError(
        interaction,
        "対象メンバーをサーバー内で確認できません。",
      );
      return;
    }
    const context = createComponentModerationContext(interaction, {
      user: targetMember.user,
      reason: `自動スパム検知 ${detectionId} へのモデレーター対応`,
      confirm: true,
    });
    const succeeded = await handleMemberModerationCommand(context, action);
    if (succeeded) {
      await deleteSpamDetectionAlert({
        interaction,
        detectionId,
        alertChannelId:
          encodedAlertChannelId ??
          spamAlertMessages.get(detectionId)?.channelId ??
          interaction.channelId,
        alertMessageId:
          encodedAlertMessageId ??
          spamAlertMessages.get(detectionId)?.messageId ??
          interaction.message.id,
      });
    }
  } finally {
    spamActionLocks.delete(lockKey);
  }
}

async function requireModerationPermission(interaction, action) {
  const config = moderationActionConfig[action];
  if (!config || !interaction.inGuild() || !interaction.guild) {
    await replyModerationError(interaction, "このコマンドはサーバー内でのみ実行できます。");
    return null;
  }
  if (isGuildBlocked(interaction.guildId)) {
    await replyModerationError(interaction, "このサーバーではBot機能が停止されています。");
    return null;
  }
  const actorIsPrivileged =
    interaction.user.id === interaction.guild.ownerId ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (
    !actorIsPrivileged &&
    !interaction.memberPermissions?.has(config.actorPermission)
  ) {
    await replyModerationError(interaction, "この操作に必要なDiscord権限がありません。");
    return null;
  }
  const botMember =
    interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const botPermissions =
    action === "clear" && interaction.channel?.permissionsFor
      ? interaction.channel.permissionsFor(botMember)
      : botMember.permissions;
  const requiredBotPermission = config.botPermission;
  if (!botPermissions?.has(requiredBotPermission)) {
    await replyModerationError(
      interaction,
      "Botの権限が不足しています。Botロールと対象チャンネルの権限を確認してください。",
    );
    return null;
  }
  return { config, botMember };
}

async function startModerationAudit(interaction, {
  action,
  targetId = null,
  targetName = null,
  channelId = null,
  reason,
  requestedCount = null,
}) {
  const id = randomUUID();
  await sql`
    INSERT INTO "bot_moderation_audit" (
      "id", "guildId", "guildName", "action", "actorId", "actorName",
      "targetId", "targetName", "channelId", "reason", "requestedCount", "status"
    )
    VALUES (
      ${id}, ${interaction.guildId}, ${interaction.guild.name}, ${action},
      ${interaction.user.id}, ${getInteractionMemberName(interaction)},
      ${targetId}, ${targetName}, ${channelId}, ${reason}, ${requestedCount}, 'pending'
    )
  `;
  console.info("[moderation-audit]", JSON.stringify({
    id,
    guildId: interaction.guildId,
    action,
    actorId: interaction.user.id,
    targetId,
    channelId,
    requestedCount,
    status: "pending",
  }));
  return id;
}

async function finishModerationAudit(id, {
  status,
  affectedCount = null,
  error = null,
}) {
  const errorCode = error ? String(error?.code ?? "DISCORD_API_ERROR").slice(0, 100) : null;
  const errorMessage = error ? safeErrorText(error).slice(0, 500) : null;
  await sql`
    UPDATE "bot_moderation_audit"
    SET
      "status" = ${status},
      "affectedCount" = ${affectedCount},
      "errorCode" = ${errorCode},
      "errorMessage" = ${errorMessage},
      "completedAt" = now()
    WHERE "id" = ${id}
  `;
  console.info("[moderation-audit]", JSON.stringify({
    id,
    status,
    affectedCount,
    errorCode,
  }));
}

function moderationAuditReason(reason, interaction, auditId) {
  return `${reason} | By ${interaction.user.username} (${interaction.user.id}) | Audit ${auditId}`.slice(0, 512);
}

async function handleMemberModerationCommand(interaction, action) {
  const access = await requireModerationPermission(interaction, action);
  if (!access) return;
  if (
    (action === "ban" || action === "kick") &&
    interaction.options.getBoolean("confirm", true) !== true
  ) {
    await replyModerationError(interaction, "末尾に `--confirm` を付けた場合のみ実行できます。");
    return;
  }

  let reason;
  let timeoutMinutes = null;
  try {
    reason = normalizeModerationReason(interaction.options.getString("reason", true));
    if (action === "timeout") {
      timeoutMinutes = validateTimeoutMinutes(
        interaction.options.getInteger("minutes", true),
      );
    }
  } catch (error) {
    await replyModerationError(interaction, error.message);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const targetUser = interaction.options.getUser("user", true);
  let actorMember;
  let targetMember;
  try {
    [actorMember, targetMember] = await Promise.all([
      interaction.guild.members.fetch(interaction.user.id),
      interaction.guild.members.fetch(targetUser.id),
    ]);
  } catch {
    await replyModerationError(interaction, "対象メンバーをサーバー内で確認できません。");
    return;
  }

  const capability = access.config.capability;
  const targetError = getModerationTargetError({
    actorId: interaction.user.id,
    botId: client.user.id,
    guildOwnerId: interaction.guild.ownerId,
    targetId: targetUser.id,
    actorRolePosition: actorMember.roles.highest.position,
    botRolePosition: access.botMember.roles.highest.position,
    targetRolePosition: targetMember.roles.highest.position,
    targetIsAdministrator: targetMember.permissions.has(PermissionFlagsBits.Administrator),
    actionAvailable: Boolean(targetMember[capability]),
  });
  if (targetError) {
    await replyModerationError(interaction, targetError);
    return;
  }

  const remainingSeconds = getModerationCooldownSeconds(interaction, action);
  if (remainingSeconds > 0) {
    await replyModerationError(
      interaction,
      `連続実行を防ぐため、${remainingSeconds}秒後にもう一度お試しください。`,
    );
    return;
  }

  const targetName = (
    targetMember.displayName ??
    targetUser.globalName ??
    targetUser.username
  ).slice(0, 100);
  let auditId;
  try {
    auditId = await startModerationAudit(interaction, {
      action,
      targetId: targetUser.id,
      targetName,
      reason,
    });
  } catch (error) {
    console.error("Failed to start moderation audit:", error);
    await replyModerationError(
      interaction,
      "監査ログを開始できなかったため、安全のため操作を中止しました。",
    );
    return;
  }

  try {
    const auditReason = moderationAuditReason(reason, interaction, auditId);
    if (action === "ban") {
      await interaction.guild.members.ban(targetUser.id, {
        deleteMessageSeconds: 0,
        reason: auditReason,
      });
    } else if (action === "kick") {
      await targetMember.kick(auditReason);
    } else if (action === "timeout") {
      await targetMember.timeout(timeoutMinutes * 60 * 1000, auditReason);
    } else {
      await targetMember.timeout(null, auditReason);
    }
    await finishModerationAudit(auditId, { status: "success", affectedCount: 1 });
  } catch (error) {
    console.error(`Moderation ${action} failed:`, error);
    await finishModerationAudit(auditId, { status: "failed", error }).catch(
      (auditError) => console.error("Failed to finish moderation audit:", auditError),
    );
    await replyModerationError(
      interaction,
      "Discord上の操作に失敗しました。ロール階層とBot権限を確認してください。",
    );
    return;
  }

  const actionText = formatModerationActionResult(action, timeoutMinutes);
  try {
    await interaction.editReply({
      content:
        `✅ **${targetName}** を${actionText}。\n` +
        `理由: ${reason}\n-# 監査ID: ${auditId}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    // The Discord action and audit already succeeded. A response delivery
    // failure must not rewrite the completed audit as a failed moderation.
    console.error(`Moderation ${action} result reply failed:`, error);
  }
  return true;
}

async function handleUnbanCommand(interaction) {
  const access = await requireModerationPermission(interaction, "unban");
  if (!access) return;
  const targetId = interaction.options.getString("user_id", true).trim();
  let reason;
  try {
    if (!validateDiscordId(targetId)) throw new Error("有効なDiscord IDを入力してください。");
    reason = normalizeModerationReason(interaction.options.getString("reason", true));
  } catch (error) {
    await replyModerationError(interaction, error.message);
    return;
  }
  const remainingSeconds = getModerationCooldownSeconds(interaction, "unban");
  if (remainingSeconds > 0) {
    await replyModerationError(
      interaction,
      `連続実行を防ぐため、${remainingSeconds}秒後にもう一度お試しください。`,
    );
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let ban;
  try {
    ban = await interaction.guild.bans.fetch(targetId);
  } catch {
    await replyModerationError(interaction, "指定したユーザーはBAN一覧で確認できません。");
    return;
  }
  let auditId;
  try {
    auditId = await startModerationAudit(interaction, {
      action: "unban",
      targetId,
      targetName: (ban.user.globalName ?? ban.user.username).slice(0, 100),
      reason,
    });
  } catch (error) {
    console.error("Failed to start moderation audit:", error);
    await replyModerationError(
      interaction,
      "監査ログを開始できなかったため、安全のため操作を中止しました。",
    );
    return;
  }
  try {
    await interaction.guild.bans.remove(
      targetId,
      moderationAuditReason(reason, interaction, auditId),
    );
    await finishModerationAudit(auditId, { status: "success", affectedCount: 1 });
    await interaction.editReply({
      content: `✅ **${ban.user.globalName ?? ban.user.username}** のBANを解除しました。\n理由: ${reason}\n-# 監査ID: ${auditId}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("Moderation unban failed:", error);
    await finishModerationAudit(auditId, { status: "failed", error }).catch(
      (auditError) => console.error("Failed to finish moderation audit:", auditError),
    );
    await replyModerationError(interaction, "BAN解除に失敗しました。Bot権限を確認してください。");
  }
}

async function handleBanlistCommand(interaction) {
  const access = await requireModerationPermission(interaction, "banlist");
  if (!access) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const bans = await interaction.guild.bans.fetch({ limit: 100 });
    const entries = [...bans.values()];
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Math.min(
      interaction.options.getInteger("page") ?? 1,
      totalPages,
    );
    const visible = entries.slice((page - 1) * pageSize, page * pageSize);
    const description = visible.length
      ? visible
          .map(
            (ban, index) =>
              `${(page - 1) * pageSize + index + 1}. ${formatGuildName(ban.user.globalName ?? ban.user.username)} (\`${ban.user.id}\`)`,
          )
          .join("\n")
      : "BANされているユーザーはいません。";
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("BANユーザー一覧")
      .setDescription(description)
      .setFooter({
        text: `${entries.length}件 · ${page}/${totalPages}ページ · 最大100件を表示`,
      });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Ban list command failed:", error);
    await replyModerationError(interaction, "BAN一覧を取得できませんでした。");
  }
}

async function handleClearCommand(interaction) {
  const access = await requireModerationPermission(interaction, "clear");
  if (!access) return;
  if (interaction.options.getBoolean("confirm", true) !== true) {
    await replyModerationError(interaction, "末尾に `--confirm` を付けた場合のみ実行できます。");
    return;
  }
  const amount = interaction.options.getInteger("amount", true);
  let reason;
  try {
    reason = normalizeModerationReason(interaction.options.getString("reason", true));
  } catch (error) {
    await replyModerationError(interaction, error.message);
    return;
  }
  if (
    !interaction.channel?.isTextBased?.() ||
    !interaction.channel.messages?.fetch ||
    !interaction.channel.bulkDelete
  ) {
    await replyModerationError(interaction, "このチャンネルではメッセージ削除を実行できません。");
    return;
  }
  const remainingSeconds = getModerationCooldownSeconds(interaction, "clear");
  if (remainingSeconds > 0) {
    await replyModerationError(
      interaction,
      `連続実行を防ぐため、${remainingSeconds}秒後にもう一度お試しください。`,
    );
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let auditId;
  try {
    auditId = await startModerationAudit(interaction, {
      action: "clear",
      channelId: interaction.channelId,
      reason,
      requestedCount: amount,
    });
  } catch (error) {
    console.error("Failed to start moderation audit:", error);
    await replyModerationError(
      interaction,
      "監査ログを開始できなかったため、安全のため操作を中止しました。",
    );
    return;
  }
  try {
    const recentMessages = await interaction.channel.messages.fetch({ limit: 100 });
    const minimumTimestamp = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const targetIds = [...recentMessages.values()]
      .filter(
        (message) =>
          message.id !== interaction.sourceMessageId &&
          !message.pinned &&
          message.createdTimestamp > minimumTimestamp,
      )
      .slice(0, amount)
      .map((message) => message.id);
    const deleted = targetIds.length
      ? await interaction.channel.bulkDelete(targetIds, true)
      : new Map();
    await finishModerationAudit(auditId, {
      status: "success",
      affectedCount: deleted.size,
    });
    await interaction.editReply({
      content:
        `✅ ${deleted.size.toLocaleString("ja-JP")}件のメッセージを削除しました。` +
        (deleted.size < amount
          ? ` ${amount - deleted.size}件はピン留め・14日超過・取得範囲外のため保護されました。`
          : "") +
        `\n理由: ${reason}\n-# 監査ID: ${auditId}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("Moderation clear failed:", error);
    await finishModerationAudit(auditId, { status: "failed", error }).catch(
      (auditError) => console.error("Failed to finish moderation audit:", auditError),
    );
    await replyModerationError(
      interaction,
      "メッセージ削除に失敗しました。チャンネル権限を確認してください。",
    );
  }
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
  const guildCount = getAvailableBotGuilds().length;
  if (runtimeCoordinator) {
    runtimeCoordinator.setStatus("Running", "Owned");
    await runtimeCoordinator.recordNow();
  }
  await sql`
    INSERT INTO "bot_heartbeat" ("id", "lastSeenAt", "startedAt", "guildCount", "stoppedAt")
    VALUES (${botHeartbeatId}, now(), ${botStartedAt}, ${guildCount}, NULL)
    ON CONFLICT ("id") DO UPDATE SET
      "lastSeenAt" = now(),
      "startedAt" = EXCLUDED."startedAt",
      "guildCount" = EXCLUDED."guildCount",
      "stoppedAt" = NULL
  `;
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
    })
    .sort((left, right) => left.channelId.localeCompare(right.channelId));
  const snapshot = JSON.stringify(channelAccess);

  if (channelAccessSnapshots.get(guild.id) === snapshot) {
    // checkedAt is a guild-level freshness indicator in every current reader.
    // Refresh one row instead of rewriting all channels when nothing changed.
    await sql`
      UPDATE "bot_channel_access"
      SET "checkedAt" = now()
      WHERE "guildId" = ${guild.id}
        AND "channelId" = (
          SELECT MIN("channelId")
          FROM "bot_channel_access"
          WHERE "guildId" = ${guild.id}
        )
    `;
    return;
  }

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
    WHERE "bot_channel_access"."channelName" IS DISTINCT FROM EXCLUDED."channelName"
       OR "bot_channel_access"."canRead" IS DISTINCT FROM EXCLUDED."canRead"
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
  await sql`
    UPDATE "bot_channel_access"
    SET "checkedAt" = now()
    WHERE "guildId" = ${guild.id}
      AND "channelId" = (
        SELECT MIN("channelId")
        FROM "bot_channel_access"
        WHERE "guildId" = ${guild.id}
      )
  `;
  channelAccessSnapshots.set(guild.id, snapshot);
}

function analyticsRoleIds(member) {
  if (!member?.roles?.cache) return [];
  return [...member.roles.cache.keys()].filter((roleId) => roleId !== member.guild.id);
}

async function recordGuildMemberEvent(member, eventType, source = "gateway") {
  if (isGuildBlocked(member.guild.id)) return;
  const occurredAt = eventType === "join" && member.joinedAt ? member.joinedAt : new Date();
  const roleIds = JSON.stringify(analyticsRoleIds(member));
  if (source === "discord_sync") {
    await sql`
      INSERT INTO "guild_member_event" ("guildId", "userId", "eventType", "isBot", "roleIds", "source", "occurredAt")
      SELECT ${member.guild.id}, ${member.id}, ${eventType}, ${member.user.bot}, ${roleIds}::jsonb, ${source}, ${occurredAt}
      WHERE NOT EXISTS (
        SELECT 1 FROM "guild_member_event"
        WHERE "guildId" = ${member.guild.id} AND "userId" = ${member.id} AND "eventType" = ${eventType}
      )
    `;
    return;
  }
  await sql`
    INSERT INTO "guild_member_event" ("guildId", "userId", "eventType", "isBot", "roleIds", "source", "occurredAt")
    VALUES (${member.guild.id}, ${member.id}, ${eventType}, ${member.user.bot}, ${roleIds}::jsonb, ${source}, ${occurredAt})
  `;
}

async function syncAnalyticsInventory(guild, { fetchMembers = false } = {}) {
  if (isGuildBlocked(guild.id)) return;
  if (fetchMembers) {
    try {
      await guild.members.fetch();
    } catch (error) {
      console.warn(`Member inventory fetch skipped for ${guild.id}:`, error.message);
    }
  }
  const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
  const channelRows = [...channels.values()]
    .filter(Boolean)
    .map((channel) => ({
      channelId: channel.id,
      channelName: "name" in channel ? channel.name : "Deleted Channel",
      channelType: String(channel.type),
    }))
    .sort((left, right) => left.channelId.localeCompare(right.channelId));
  const roleRows = [...roles.values()]
    .filter(Boolean)
    .map((role) => ({
      roleId: role.id,
      roleName: role.name,
      memberCount: role.members?.size ?? 0,
      isManaged: role.managed,
      isBotRole: Boolean(role.tags?.botId),
      isEveryone: role.id === guild.id,
      color: role.color,
      position: role.position,
    }))
    .sort((left, right) => left.roleId.localeCompare(right.roleId));
  const inventorySnapshot = JSON.stringify([channelRows, roleRows]);
  if (analyticsInventorySnapshots.get(guild.id) !== inventorySnapshot) {
    await sql`
      INSERT INTO "guild_channel_registry" ("guildId", "channelId", "channelName", "channelType", "deletedAt", "updatedAt")
      SELECT ${guild.id}, row."channelId", row."channelName", row."channelType", NULL, now()
      FROM jsonb_to_recordset(${JSON.stringify(channelRows)}::jsonb)
        AS row("channelId" text, "channelName" text, "channelType" text)
      ON CONFLICT ("guildId", "channelId") DO UPDATE SET
        "channelName" = EXCLUDED."channelName", "channelType" = EXCLUDED."channelType", "deletedAt" = NULL, "updatedAt" = now()
      WHERE "guild_channel_registry"."channelName" IS DISTINCT FROM EXCLUDED."channelName"
         OR "guild_channel_registry"."channelType" IS DISTINCT FROM EXCLUDED."channelType"
         OR "guild_channel_registry"."deletedAt" IS NOT NULL
    `;
    await sql`
      UPDATE "guild_channel_registry" registry SET "deletedAt" = now(), "updatedAt" = now()
      WHERE registry."guildId" = ${guild.id}
        AND registry."deletedAt" IS NULL
        AND NOT (registry."channelId" = ANY(${channelRows.map((row) => row.channelId)}::text[]))
    `;
    await sql`
      INSERT INTO "guild_role_registry" ("guildId", "roleId", "roleName", "memberCount", "isManaged", "isBotRole", "isEveryone", "color", "position", "deletedAt", "updatedAt")
      SELECT ${guild.id}, row."roleId", row."roleName", row."memberCount", row."isManaged", row."isBotRole", row."isEveryone", row."color", row."position", NULL, now()
      FROM jsonb_to_recordset(${JSON.stringify(roleRows)}::jsonb)
        AS row("roleId" text, "roleName" text, "memberCount" integer, "isManaged" boolean, "isBotRole" boolean, "isEveryone" boolean, "color" integer, "position" integer)
      ON CONFLICT ("guildId", "roleId") DO UPDATE SET
        "roleName" = EXCLUDED."roleName", "memberCount" = EXCLUDED."memberCount", "isManaged" = EXCLUDED."isManaged",
        "isBotRole" = EXCLUDED."isBotRole", "isEveryone" = EXCLUDED."isEveryone", "color" = EXCLUDED."color",
        "position" = EXCLUDED."position", "deletedAt" = NULL, "updatedAt" = now()
      WHERE "guild_role_registry"."roleName" IS DISTINCT FROM EXCLUDED."roleName"
         OR "guild_role_registry"."memberCount" IS DISTINCT FROM EXCLUDED."memberCount"
         OR "guild_role_registry"."isManaged" IS DISTINCT FROM EXCLUDED."isManaged"
         OR "guild_role_registry"."isBotRole" IS DISTINCT FROM EXCLUDED."isBotRole"
         OR "guild_role_registry"."isEveryone" IS DISTINCT FROM EXCLUDED."isEveryone"
         OR "guild_role_registry"."color" IS DISTINCT FROM EXCLUDED."color"
         OR "guild_role_registry"."position" IS DISTINCT FROM EXCLUDED."position"
         OR "guild_role_registry"."deletedAt" IS NOT NULL
    `;
    await sql`
      UPDATE "guild_role_registry" registry SET "deletedAt" = now(), "updatedAt" = now()
      WHERE registry."guildId" = ${guild.id}
        AND registry."deletedAt" IS NULL
        AND NOT (registry."roleId" = ANY(${roleRows.map((row) => row.roleId)}::text[]))
    `;
    analyticsInventorySnapshots.set(guild.id, inventorySnapshot);
  }
  if (fetchMembers) {
    for (const member of guild.members.cache.values()) {
      await recordGuildMemberEvent(member, "join", "discord_sync");
    }
  }
}

async function updateVoiceAnalytics(oldState, newState) {
  const guild = newState.guild;
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot || isGuildBlocked(guild.id)) return;
  if (oldState.channelId) {
    await sql`
      UPDATE "voice_session" SET "endedAt" = now()
      WHERE "guildId" = ${guild.id} AND "userId" = ${member.id} AND "endedAt" IS NULL
    `;
  }
  if (newState.channelId) {
    await sql`
      INSERT INTO "voice_session" ("guildId", "userId", "channelId", "userIsBot", "userRoleIds", "startedAt")
      VALUES (${guild.id}, ${member.id}, ${newState.channelId}, false, ${JSON.stringify(analyticsRoleIds(member))}::jsonb, now())
      ON CONFLICT ("guildId", "userId") WHERE "endedAt" IS NULL DO NOTHING
    `;
  }
}

async function syncCurrentVoiceSessions(guild) {
  await sql`
    UPDATE "voice_session" SET "endedAt" = now()
    WHERE "guildId" = ${guild.id} AND "endedAt" IS NULL
  `;
  for (const state of guild.voiceStates.cache.values()) {
    if (!state.channelId || state.member?.user.bot !== false) continue;
    await sql`
      INSERT INTO "voice_session" ("guildId", "userId", "channelId", "userIsBot", "userRoleIds", "startedAt")
      VALUES (${guild.id}, ${state.member.id}, ${state.channelId}, false, ${JSON.stringify(analyticsRoleIds(state.member))}::jsonb, now())
      ON CONFLICT ("guildId", "userId") WHERE "endedAt" IS NULL DO NOTHING
    `;
  }
}

// Alerts live in the database rather than in Discord DMs. Every authorized
// dashboard manager can then see the same operational warning without the Bot
// needing to know anyone's account or contact details.
async function emitGuildAlert({ guildId, type, severity = "warning", title, body, cooldownMinutes }) {
  const recent = await sql`
    SELECT "id" FROM "guild_alert_event"
    WHERE "guildId" = ${guildId} AND "type" = ${type}
      AND "createdAt" >= now() - (${cooldownMinutes} * interval '1 minute')
    LIMIT 1
  `;
  if (recent.length) return;
  await sql`
    INSERT INTO "guild_alert_event" ("guildId", "type", "severity", "title", "body")
    VALUES (${guildId}, ${type}, ${severity}, ${title}, ${body})
  `;
}

async function checkGuildAlerts(guild) {
  if (isGuildBlocked(guild.id)) return;
  const [activityRows, departureRows, unreadableRows] = await Promise.all([
    sql`
      SELECT MAX("occurredAt") AS "lastMessageAt"
      FROM "recent_activity"
      WHERE "guildId" = ${guild.id} AND "type" = 'message'
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM "recent_activity"
      WHERE "guildId" = ${guild.id} AND "type" = 'member_left'
        AND "occurredAt" >= now() - interval '1 hour'
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM "bot_channel_access"
      WHERE "guildId" = ${guild.id} AND "canRead" = false
    `,
  ]);
  const lastMessageAt = activityRows[0]?.lastMessageAt ? new Date(activityRows[0].lastMessageAt) : null;
  if (lastMessageAt && Date.now() - lastMessageAt.getTime() >= inactivityAlertHours * 60 * 60 * 1000) {
    await emitGuildAlert({
      guildId: guild.id,
      type: "message_inactive",
      severity: "notice",
      title: "24時間メッセージがありません",
      body: `「${guild.name}」では過去24時間、新しいメッセージを記録していません。`,
      cooldownMinutes: 24 * 60,
    });
  }
  const departures = Number(departureRows[0]?.count ?? 0);
  if (departures >= departureAlertThreshold) {
    await emitGuildAlert({
      guildId: guild.id,
      type: "member_departures_spike",
      severity: "warning",
      title: "メンバー退出が増えています",
      body: `「${guild.name}」では直近1時間に${departures}人の退出を記録しました。`,
      cooldownMinutes: 60,
    });
  }
  const unreadable = Number(unreadableRows[0]?.count ?? 0);
  if (unreadable > 0) {
    await emitGuildAlert({
      guildId: guild.id,
      type: "channel_permission_missing",
      severity: "warning",
      title: "Botが記録できないチャンネルがあります",
      body: `「${guild.name}」で${unreadable}件のチャンネルを読み取れません。/permissions で確認してください。`,
      cooldownMinutes: 24 * 60,
    });
  }
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
  const roleIds = JSON.stringify(analyticsRoleIds(message.member));
  if (messageImportConfig.enabled) {
    await sql`
      INSERT INTO "discord_message" ("id", "guildId", "channelId", "channelName", "authorId", "authorName", "authorIsBot", "authorRoleIds", "content", "source", "importJobId", "createdAt", "updatedAt")
      VALUES (${message.id}, ${message.guild.id}, ${message.channel.id}, ${channelName}, ${message.author.id}, ${message.member?.displayName ?? message.author.username}, ${message.author.bot}, ${roleIds}::jsonb, ${message.content}, ${MESSAGE_SOURCE.live}, NULL, ${message.createdAt}, now())
      ON CONFLICT ("id") DO UPDATE SET
        "channelId" = EXCLUDED."channelId",
        "channelName" = EXCLUDED."channelName",
        "authorName" = EXCLUDED."authorName",
        "authorIsBot" = EXCLUDED."authorIsBot",
        "authorRoleIds" = EXCLUDED."authorRoleIds",
        "content" = EXCLUDED."content",
        "source" = ${MESSAGE_SOURCE.live},
        "importJobId" = NULL,
        "updatedAt" = now()
    `;
    return;
  }
  await sql`
    INSERT INTO "discord_message" ("id", "guildId", "channelId", "channelName", "authorId", "authorName", "authorIsBot", "authorRoleIds", "content", "createdAt", "updatedAt")
    VALUES (${message.id}, ${message.guild.id}, ${message.channel.id}, ${channelName}, ${message.author.id}, ${message.member?.displayName ?? message.author.username}, ${message.author.bot}, ${roleIds}::jsonb, ${message.content}, ${message.createdAt}, now())
    ON CONFLICT ("id") DO UPDATE SET "channelId" = EXCLUDED."channelId", "channelName" = EXCLUDED."channelName", "authorName" = EXCLUDED."authorName", "authorIsBot" = EXCLUDED."authorIsBot", "authorRoleIds" = EXCLUDED."authorRoleIds", "content" = EXCLUDED."content", "updatedAt" = now()
  `;
}

async function purgeExpiredMessages() {
  await sql`DELETE FROM "discord_message" WHERE "createdAt" < now() - (${messageRetentionDays} * interval '1 day')`;
}

const historyImportDelayMs = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateLegacyHistoryImportJob(id, fields) {
  await sql`
    UPDATE "history_import_job"
    SET "processedMessages" = ${fields.processedMessages}, "failedChannels" = ${fields.failedChannels}
    WHERE "id" = ${id}
  `;
}

async function claimLegacyHistoryImportJob() {
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
async function processLegacyHistoryImportJob(job) {
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
    // A zero-day job means every message Discord still makes available.
    const cutoff = job.days === 0
      ? new Date(0)
      : new Date(Date.now() - job.days * 24 * 60 * 60 * 1000);
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
          await updateLegacyHistoryImportJob(job.id, {
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
        await updateLegacyHistoryImportJob(job.id, {
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

async function pollLegacyHistoryImportJobs() {
  const job = await claimLegacyHistoryImportJob();
  if (job) await processLegacyHistoryImportJob(job);
}

async function pollHistoryImportJobs() {
  if (messageImportConfig.enabled) return messageHistoryImportWorker.poll();
  return pollLegacyHistoryImportJobs();
}

let guildResetRequestPolling = false;
async function pollGuildResetRequests() {
  if (!guildResetConfig.enabled || guildResetRequestPolling) return;
  guildResetRequestPolling = true;
  try {
    await guildResetService.processDashboardRequest();
  } finally {
    guildResetRequestPolling = false;
  }
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
  runtimeCoordinator?.setStatus("Running", "Owned");
  updateRuntimeOperationalMetrics({ discordReadyAt: new Date().toISOString() });
  updateBotPresence();
  console.log(`NuviloView:OEM bot logged in as ${client.user.tag}`);
  try {
    await loadBlockedGuilds();
    await loadReactionRoleRules();
    updateBotPresence();
    await recordBotHeartbeat();
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
    const initialAnalyticsResults = await Promise.allSettled(
      client.guilds.cache.map((guild) => syncAnalyticsInventory(guild, { fetchMembers: true })),
    );
    await Promise.all(client.guilds.cache.map(updateMemberCount));
    await Promise.allSettled(
      client.guilds.cache.map(restoreTodayActiveMembers),
    );
    await Promise.allSettled(client.guilds.cache.map(syncChannelAccess));
    await Promise.allSettled(client.guilds.cache.map(checkGuildAlerts));
    await Promise.allSettled(client.guilds.cache.map(syncServerVoiceSession));
    await Promise.allSettled(client.guilds.cache.map(syncCurrentVoiceSessions));
    await Promise.allSettled(client.guilds.cache.map((guild) => nukeProtectionService.diagnoseGuild(guild)));
    await Promise.allSettled(client.guilds.cache.map((guild) => nukeProtectionService.ensureDailySnapshot(guild)));
    updateRuntimeOperationalMetrics(
      initialAnalyticsResults.some((result) => result.status === "rejected")
        ? { lastAnalyticsFailureAt: new Date().toISOString() }
        : { lastAnalyticsSuccessAt: new Date().toISOString() },
    );
    await purgeExpiredMessages();
    void pollHistoryImportJobs();
    void pollGuildResetRequests();
    void nukeProtectionService.pollActionRequests();
  } catch (error) {
    updateRuntimeOperationalMetrics({ lastAnalyticsFailureAt: new Date().toISOString() });
    console.error("Initial member sync failed:", error);
  }
});

client.on("guildCreate", (guild) =>
  void (async () => {
    updateBotPresence();
    await syncGuildRegistry(guild);
    if (await leaveBlockedGuild(guild, "re-invite")) return;
    await Promise.allSettled([
      syncGuildCommands(guild.id),
      updateMemberCount(guild),
      restoreTodayActiveMembers(guild),
      syncChannelAccess(guild),
      syncAnalyticsInventory(guild, { fetchMembers: true }),
      syncServerVoiceSession(guild),
      syncCurrentVoiceSessions(guild),
      nukeProtectionService.diagnoseGuild(guild),
      nukeProtectionService.ensureDailySnapshot(guild),
      loadReactionRoleRules(guild.id),
    ]);
  })(),
);

client.on("guildDelete", (guild) => {
  updateBotPresence();
  channelAccessSnapshots.delete(guild.id);
  analyticsInventorySnapshots.delete(guild.id);
  clearGuildReactionRoleRules(guild.id);
  nukeProtectionService.clearGuild(guild.id);
  void markGuildDisconnected(guild.id).catch((error) =>
    console.error("Failed to mark removed guild as disconnected:", error),
  );
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "translate") {
      await interaction
        .respond(
          getTranslationAutocompleteChoices(
            String(interaction.options.getFocused()),
          ),
        )
        .catch(() => {});
      return;
    }
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("zxgame:")
  ) {
    await handleDiceRollComponent(interaction);
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("nvspam:")
  ) {
    await handleSpamActionComponent(interaction);
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("nvsnipe:")
  ) {
    await handleSnipeComponent(interaction);
    return;
  }

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
    const requestId = createTranslationRequest(
      interaction.user.id,
      content,
      createTranslationLanguageMetadata(availableLanguages),
    );
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
      const embed = createTranslationResultEmbed({
        translated,
        targetLanguage,
        languageNames: request.supportedLanguages.languageNames,
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
      const embed = createTranslationResultEmbed({
        translated,
        targetLanguage,
        languageNames: request.supportedLanguages.languageNames,
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
  if (interaction.commandName === "translate") {
    try {
      await handleTranslateSlashCommand(interaction);
    } catch (error) {
      console.error("/translate command failed:", error);
      const errorPayload = {
        content:
          "翻訳コマンドの処理中にエラーが発生しました。少し待ってから再実行してください。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(errorPayload).catch(() => {});
      } else {
        await interaction.reply(errorPayload).catch(() => {});
      }
    }
    return;
  }
  if (interaction.commandName === "zx") {
    try {
      await handleZxSlashCommand(interaction);
    } catch (error) {
      console.error("/zx command failed:", error);
      const errorPayload = {
        content:
          "❌ 娯楽コマンドの処理中にエラーが発生しました。少し待ってから再実行してください。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorPayload).catch(() => {});
      } else {
        await interaction.reply(errorPayload).catch(() => {});
      }
    }
    return;
  }
  if (interaction.commandName === "dev-reset-plan") {
    await handleDevResetPlanCommand(interaction);
    return;
  }
  if (interaction.commandName === "dev-reset-code") {
    await handleDevResetCodeCommand(interaction);
    return;
  }
  if (interaction.commandName === "dev-reset-confirm") {
    await handleDevResetConfirmCommand(interaction);
    return;
  }
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
    const guilds = getAvailableBotGuilds();
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(guilds.length / pageSize));
    const requestedPage = interaction.options.getInteger("page") ?? 1;
    const page = Math.min(Math.max(requestedPage, 1), totalPages);
    const currentGuilds = guilds.slice((page - 1) * pageSize, page * pageSize);
    const embeds = await Promise.all(
      currentGuilds.map(async (guild, index) => {
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
          .setTitle(`${(page - 1) * pageSize + index + 1}. ${formatGuildName(guild.name)}`)
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
      .setDescription(
        "NuviloView:OEMとNuviloChan Botにおける主なデータ処理の要約です。詳細版と削除等の窓口は下記リンクから確認できます。",
      )
      .addFields(
        {
          name: "分析・サーバー情報",
          value:
            "サーバーのID・名称・アイコン・所有者ID・メンバー数、投稿数、リアクション数、参加・退出、日別の発言者ID、チャンネル情報とBotの権限状態を記録します。",
        },
        {
          name: "通話情報",
          value:
            "通話時間の集計に、参加者のDiscord ID、チャンネルID、参加・退出時刻を記録します。音声、映像、画面共有の内容は取得・保存しません。",
        },
        {
          name: "メッセージと履歴取込",
          value:
            `検索機能のため、Botが閲覧できるチャンネルの本文、メッセージ・投稿者ID、表示名、チャンネル名、投稿日時を最大${messageRetentionDays}日間保存します。` +
            "削除イベントを受信した本文は検索用DBから削除します。添付ファイル本体、埋め込み・スタンプの内容は保存しません。",
        },
        {
          name: "一時処理",
          value:
            "zx?snipeはチャンネルごとに最大999,999件の削除本文・投稿者・削除者等をBotメモリで最大90日間（約3か月）保持し、上限超過時は古い履歴から切り捨てます。結果は実行チャンネルを閲覧できるメンバーに表示します。" +
            "翻訳本文・結果は最大5分の一時処理のみでDB保存せず、月間文字数合計だけを記録します。スパム判定は送信時刻と件数を短時間だけ比較し、判定用に本文を追加保存しません。",
        },
        {
          name: "認証・設定・操作ログ",
          value:
            "Discord ID、表示名、アイコン、管理可能サーバー、OAuthトークン、セッション、テーマ・目標・通知等の設定を機能提供に使用します。" +
            "モデレーションは実行者・対象・理由・件数・成否を監査ログへ記録します。運営者向け管理機能では構成情報、操作履歴、必要なバックアップを保存する場合があります。",
        },
        {
          name: "取得・利用しないもの",
          value:
            "Discord OAuthでメール権限を要求せず、Discord登録メールは取得しません。DM本文、通話音声・映像・画面共有、添付ファイル本体は保存しません。" +
            "Discord APIデータやメッセージ本文を広告ターゲティング、データ販売、AIモデル学習に使用しません。",
        },
        {
          name: "閲覧範囲・削除",
          value:
            "ダッシュボードと検索は対象サーバーの所有者または管理権限者に限定します。翻訳結果は実行者だけに表示します。" +
            "Bot退出後は新規収集を停止します。既存データの開示・訂正・利用停止・削除はサポートから申請できます。",
        },
        {
          name: "詳細・お問い合わせ",
          value: `${dashboardUrl}privacy\n${dashboardUrl}support`,
        },
      )
      .setFooter({ text: "最終更新: 2026年7月29日" });
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

  if (interaction.commandName === "setroll") {
    try {
      await handleSetRollCommand(interaction);
    } catch (error) {
      console.error("/setroll command failed:", error);
      const payload = {
        content: "リアクションロール設定の処理に失敗しました。Bot権限と入力内容を確認してください。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
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
        name: "🌐　**/translate**",
        value:
          "━━━━━━━━━━━━━━━━━━\n入力したテキストを翻訳します。翻訳先を省略すると言語一覧から選べます。結果は実行者だけに表示され、入力本文と翻訳結果は保存しません。",
        inline: false,
      },
      {
        name: "🎭　**/setroll**",
        value:
          "━━━━━━━━━━━━━━━━━━\n管理者が、特定メッセージのリアクションで受け取れるロールを最大10個まで設定できます。`add`・`remove`・`list`に対応しています。",
        inline: false,
      },
      {
        name: "🛡️　**セキュリティ・モデレーション**",
        value:
          "━━━━━━━━━━━━━━━━━━\nセキュリティ機能は独立した `r?` コマンドです。`r?help` で一覧と使い方、`r?perm_check`で実行者とBotの権限を確認できます。\n5秒以内に同一ユーザーまたはBotが3件送信するとスパムを検知し、5分間のタイムアウトを試行します。検知通知からTO解除・Kick・BANを選択できます。",
        inline: false,
      },
      {
        name: "🎮　**娯楽コマンド**",
        value:
          "━━━━━━━━━━━━━━━━━━\n`zx?`を入力するとDiscordの候補欄から`/zx`を選べます。`zx?dice`・`zx?snipe`と`/zx`は全メンバーが利用できます。",
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
          "`/help`、`/privacy`、`/translate`、`zx?dice`・`zx?snipe`・`/zx`は全員利用できます。分析機能はサーバー管理者、セキュリティ機能は各操作に対応するDiscord権限を持つメンバーのみ実行できます。",
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
  if (!message.guild || isGuildBlocked(message.guild.id)) return;

  const trackSpam = () => {
    if (
      !spamProtectionEnabled ||
      !shouldTrackSpamMessage({
        authorId: message.author.id,
        clientUserId: client.user?.id,
        isWebhook: Boolean(message.webhookId),
      })
    ) {
      return;
    }
    const spamDetection = spamTracker.record(
      `${message.guild.id}:${message.author.id}`,
      message.createdTimestamp,
    );
    if (spamDetection.detected) {
      void handleSpamDetection(message, spamDetection).catch((error) =>
        console.error("Spam detection handling failed:", error),
      );
    }
  };

  if (message.author.bot) {
    await nukeProtectionService.handleBotMessage(message);
    trackSpam();
    return;
  }

  const securityInvocation = parseSecurityCommand(message.content);
  if (securityInvocation) {
    try {
      await handlePrefixSecurityCommand(message, securityInvocation);
    } catch (error) {
      console.error("Prefix security command failed:", error);
      await message.channel
        .send({
          content: "❌ コマンド処理中にエラーが発生しました。少し待ってから再実行してください。",
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
    return;
  }

  const entertainmentInvocation = parseEntertainmentCommand(message.content);
  if (entertainmentInvocation) {
    try {
      await handlePrefixEntertainmentCommand(message, entertainmentInvocation);
    } catch (error) {
      console.error("Prefix entertainment command failed:", error);
      await message.channel
        .send({
          content:
            "❌ 娯楽コマンドの処理中にエラーが発生しました。少し待ってから再実行してください。",
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
    return;
  }

  trackSpam();

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

async function resolveMessageDeleteExecutor(
  message,
  authorId,
  auditLogType = AuditLogEvent.MessageDelete,
) {
  if (!message.guild || (auditLogType === AuditLogEvent.MessageDelete && !authorId)) {
    return null;
  }
  const botMember =
    message.guild.members.me ?? (await message.guild.members.fetchMe());
  if (!botMember.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

  await delay(750);
  try {
    const auditLogs = await message.guild.fetchAuditLogs({
      type: auditLogType,
      limit: 6,
    });
    const cutoff = Date.now() - 7_500;
    const entry = auditLogs.entries.find(
      (candidate) =>
        candidate.createdTimestamp >= cutoff &&
        (auditLogType === AuditLogEvent.MessageBulkDelete ||
          candidate.target?.id === authorId) &&
        candidate.extra?.channel?.id === message.channelId,
    );
    if (!entry?.executor) return null;
    return {
      id: entry.executor.id,
      name:
        entry.executor.globalName ??
        entry.executor.username ??
        "不明なユーザー",
    };
  } catch (error) {
    console.warn("Could not resolve message deleter from Discord audit log:", safeErrorText(error));
    return null;
  }
}

async function rememberDeletedMessageForSnipe(
  message,
  storedMessage,
  auditLogType = AuditLogEvent.MessageDelete,
  resolvedDeleter = undefined,
) {
  const isSnipeResult = message.components?.some((row) =>
    row.components?.some((component) =>
      component.customId?.startsWith("nvsnipe:"),
    ),
  );
  if (
    !message.guild ||
    ignoredSnipeDeleteIds.delete(message.id) ||
    snipeResultSessions.delete(message.id) ||
    isSnipeResult
  ) {
    return;
  }
  const deletedAt = Date.now();
  const authorId = message.author?.id ?? storedMessage?.authorId ?? null;
  const authorName =
    message.member?.displayName ??
    message.author?.globalName ??
    message.author?.username ??
    storedMessage?.authorName ??
    "不明なユーザー";
  const content = message.content?.trim() || storedMessage?.content || "";
  const deleter =
    resolvedDeleter === undefined
      ? await resolveMessageDeleteExecutor(message, authorId, auditLogType)
      : resolvedDeleter;
  const key = getSnipeChannelKey(message.guild.id, message.channelId);
  const record = {
    messageId: message.id,
    authorId,
    authorName,
    content,
    deletedById: deleter?.id ?? null,
    deletedByName: deleter?.name ?? null,
    deletedAt,
  };
  const history = [record];
  for (const candidate of getLiveDeletedMessageSnipes(key)) {
    if (candidate.messageId === message.id) continue;
    history.push(candidate);
    if (history.length >= SNIPE_HISTORY_LIMIT) break;
  }
  deletedMessageSnipes.set(key, history);
  scheduleSnipeHistoryCleanup(key);
}

async function processDeletedMessageForSnipe(
  message,
  auditLogType = AuditLogEvent.MessageDelete,
  resolvedDeleter = undefined,
) {
  let storedMessage = null;
  try {
    const rows = await sql`
      SELECT "authorId", "authorName", "content"
      FROM "discord_message"
      WHERE "id" = ${message.id}
      LIMIT 1
    `;
    storedMessage = rows[0] ?? null;
    await sql`DELETE FROM "discord_message" WHERE "id" = ${message.id}`;
  } catch (error) {
    console.error("Failed to remove a deleted Discord message:", error);
  }
  await rememberDeletedMessageForSnipe(
    message,
    storedMessage,
    auditLogType,
    resolvedDeleter,
  ).catch((error) =>
    console.error("Failed to retain a transient Snipe record:", error),
  );
}

client.on("messageDelete", async (message) => {
  await processDeletedMessageForSnipe(message);
});

client.on("messageDeleteBulk", async (messages) => {
  const deletedMessages = [...messages.values()];
  const bulkDeleter = deletedMessages[0]
    ? await resolveMessageDeleteExecutor(
        deletedMessages[0],
        null,
        AuditLogEvent.MessageBulkDelete,
      )
    : null;
  for (const message of deletedMessages) {
    await processDeletedMessageForSnipe(
      message,
      AuditLogEvent.MessageBulkDelete,
      bulkDeleter,
    );
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (
    user.bot ||
    !reaction.message.guild ||
    isGuildBlocked(reaction.message.guild.id)
  )
    return;
  await applyReactionRoleChange(reaction, user, true).catch((error) =>
    console.error("Failed to apply a reaction role:", error),
  );
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    const guild = reaction.message.guild;
    const reactor = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id).catch(() => null);
    await sql`
      INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "reactionCount", "date")
      VALUES (${guild.id}, ${guild.memberCount}, 0, 1, CURRENT_DATE)
      ON CONFLICT ("guildId", "date")
      DO UPDATE SET
        "reactionCount" = "daily_stats"."reactionCount" + 1,
        "memberCount" = EXCLUDED."memberCount",
        "updatedAt" = now()
    `;
    await sql`
      INSERT INTO "discord_reaction_event" ("guildId", "channelId", "messageId", "reactorId", "recipientId", "reactorIsBot", "reactorRoleIds", "occurredAt")
      VALUES (${guild.id}, ${reaction.message.channelId ?? null}, ${reaction.message.id}, ${user.id}, ${reaction.message.author?.id ?? null}, ${user.bot}, ${JSON.stringify(analyticsRoleIds(reactor))}::jsonb, now())
    `;
  } catch (error) {
    console.error("Failed to count a Discord reaction:", error);
  }
});

client.on("messageReactionRemove", async (reaction, user) => {
  await applyReactionRoleChange(reaction, user, false).catch((error) =>
    console.error("Failed to remove a reaction role:", error),
  );
});

client.on("voiceStateUpdate", (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;
  if (isGuildBlocked(newState.guild.id)) return;
  void updateVoiceAnalytics(oldState, newState).catch((error) =>
    console.error("Failed to sync member voice analytics:", error),
  );
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
      recordGuildMemberEvent(member, "join"),
      syncAnalyticsInventory(member.guild),
      syncGuildRegistry(member.guild),
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
      recordGuildMemberEvent(member, "leave"),
      syncAnalyticsInventory(member.guild),
      syncGuildRegistry(member.guild),
      syncServerVoiceSession(member.guild),
    ])
    );
  },
);
client.on("error", (error) => {
  updateRuntimeOperationalMetrics({ lastDiscordErrorAt: new Date().toISOString() });
  console.error("Discord client error:", error);
  void reportOperationalAlert("Discord client error", error);
});

client.on("shardDisconnect", (_event, shardId) => {
  updateRuntimeOperationalMetrics({
    lastDiscordDisconnectAt: new Date().toISOString(),
    disconnectCount: runtimeOperationalMetrics.disconnectCount + 1,
  });
  console.warn(`[Discord] shard ${shardId} disconnected.`);
});

client.on("shardReconnecting", (shardId) => {
  updateRuntimeOperationalMetrics({
    lastDiscordReconnectAt: new Date().toISOString(),
    reconnectCount: runtimeOperationalMetrics.reconnectCount + 1,
  });
  console.warn(`[Discord] shard ${shardId} reconnecting.`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  updateRuntimeOperationalMetrics({ lastDiscordResumeAt: new Date().toISOString() });
  console.info(`[Discord] shard ${shardId} resumed with ${replayedEvents} replayed event(s).`);
});

client.on("invalidated", () => {
  updateRuntimeOperationalMetrics({ lastDiscordInvalidSessionAt: new Date().toISOString() });
  console.error("[Discord] gateway session invalidated.");
});

client.rest.on("rateLimited", (rateLimit) => {
  updateRuntimeOperationalMetrics({
    lastDiscordRateLimitAt: new Date().toISOString(),
    rateLimitCount: runtimeOperationalMetrics.rateLimitCount + 1,
  });
  console.warn(
    `[Discord] REST rate limited global=${Boolean(rateLimit.global)} retryAfterMs=${Math.ceil(rateLimit.timeToReset || 0)}`,
  );
});

client.on("guildAuditLogEntryCreate", (entry, guild) => {
  if (isGuildBlocked(guild.id)) return;
  void nukeProtectionService.handleAuditLogEntry(entry, guild);
});

client.on("webhookUpdate", (channel) => {
  if (!channel?.guild || isGuildBlocked(channel.guild.id)) return;
  void nukeProtectionService.handleWebhookUpdate(channel);
});

for (const eventName of ["channelCreate", "channelDelete", "channelUpdate", "roleCreate", "roleDelete", "roleUpdate"]) {
  client.on(eventName, (...args) => {
    const subject = args.at(-1) ?? args[0];
    const guild = subject?.guild;
    if (!guild || isGuildBlocked(guild.id)) return;
    void Promise.allSettled([
      syncAnalyticsInventory(guild),
      syncChannelAccess(guild),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(`Failed to refresh Bot inventory after ${eventName}:`, result.reason);
        }
      }
    });
  });
}

client.on("guildMemberUpdate", (before, after) => {
  if (isGuildBlocked(after.guild.id)) return;
  const rolesChanged =
    before.roles.cache.size !== after.roles.cache.size ||
    [...before.roles.cache.keys()].some((roleId) => !after.roles.cache.has(roleId));
  if (!rolesChanged) return;
  void syncAnalyticsInventory(after.guild).catch((error) =>
    console.error("Failed to refresh role analytics after member update:", error),
  );
  if (after.id === client.user?.id) {
    void syncChannelAccess(after.guild).catch((error) =>
      console.error("Failed to refresh channel permissions after Bot role update:", error),
    );
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Bot rejection:", error);
  void reportOperationalAlert("Unhandled Bot error", error);
});

setInterval(
  () => {
    void (async () => {
      const results = await Promise.allSettled(
        client.guilds.cache.map(async (guild) => {
          await updateMemberCount(guild);
          await syncChannelAccess(guild);
          await syncAnalyticsInventory(guild);
          await syncGuildRegistry(guild);
          await checkGuildAlerts(guild);
          await nukeProtectionService.diagnoseGuild(guild);
        }),
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      updateRuntimeOperationalMetrics(
        failed
          ? { lastAnalyticsFailureAt: new Date().toISOString() }
          : { lastAnalyticsSuccessAt: new Date().toISOString() },
      );
    })();
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
}, 60 * 1000);

setInterval(() => {
  void pollGuildResetRequests().catch((error) =>
    console.error("Failed to poll Guild reset requests:", error),
  );
}, 5 * 1000);

setInterval(() => {
  void nukeProtectionService.pollActionRequests();
}, 5 * 1000);

setInterval(() => {
  void Promise.allSettled(
    client.guilds.cache.map((guild) => nukeProtectionService.ensureDailySnapshot(guild)),
  );
}, 60 * 60 * 1000);

setInterval(() => {
  void nukeProtectionService.purgeExpiredSecurityData().catch((error) =>
    console.error("Failed to purge expired Nuke Protection data:", error),
  );
}, 12 * 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, request] of translationRequests) {
    if (request.expiresAt < now) translationRequests.delete(id);
  }
}, 60 * 1000);

let shuttingDown = false;
let localStopWatcher;
async function shutdown(
  signal,
  exitCode = RUNTIME_EXIT_CODES.NORMAL,
  { releaseLease = true } = {},
) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (localStopWatcher) clearInterval(localStopWatcher);
  console.log(`${signal} received. Disconnecting NuviloChan Bot...`);
  client.destroy();
  if (releaseLease) {
    try {
      await sql`
        UPDATE "bot_heartbeat"
        SET "stoppedAt" = now()
        WHERE "id" = ${botHeartbeatId}
      `;
    } catch (error) {
      console.error("Failed to mark Bot as stopped:", error);
    }
  }
  if (runtimeCoordinator) {
    await runtimeCoordinator.stop({
      release: releaseLease,
      finalStatus: releaseLease ? "Stopped" : "LeaseLost",
    });
  }
  process.exit(exitCode);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

const localStopFile = process.env.NUVILOVIEW_BOT_STOP_FILE?.trim();
if (localStopFile && isAbsolute(localStopFile)) {
  localStopWatcher = setInterval(() => {
    if (existsSync(localStopFile)) void shutdown("LOCAL_STOP_REQUEST");
  }, 1_000);
  localStopWatcher.unref();
}

async function startBot() {
  if (runtimeConfig.enabled) {
    const configurationErrors = validateRuntimeConfig(runtimeConfig, runtimeIdentity);
    if (configurationErrors.length) {
      for (const error of configurationErrors) {
        console.error(`[Singleton] configuration invalid: ${error}`);
      }
      return RUNTIME_EXIT_CODES.CONFIGURATION_INVALID;
    }

    runtimeCoordinator = new RuntimeCoordinator({
      repository: runtimeRepository,
      config: runtimeConfig,
      identity: runtimeIdentity,
      heartbeatData: () => ({
        guildCount: client.isReady() ? getAvailableBotGuilds().length : 0,
        metadata: {
          ...runtimeOperationalMetrics,
          discordReady: client.isReady(),
        },
      }),
      onLeaseLost: async () => {
        await shutdown("LEASE_LOST", RUNTIME_EXIT_CODES.LEASE_LOST, {
          releaseLease: false,
        });
      },
    });

    let acquisition;
    try {
      acquisition = await runtimeCoordinator.acquire();
    } catch (error) {
      console.error("[Singleton] database unavailable during lease acquisition", error);
      return RUNTIME_EXIT_CODES.DATABASE_UNAVAILABLE;
    }
    if (!acquisition.acquired) {
      const owner = acquisition.owner;
      console.info(
        `[Singleton] another NuviloView instance owns the lease; Discord login was skipped host=${owner?.hostId || "unknown"} expires=${owner?.leaseExpiresAt?.toISOString?.() || "unknown"}`,
      );
      return RUNTIME_EXIT_CODES.LEASE_CONTENDED;
    }

    try {
      await runtimeCoordinator.start();
    } catch (error) {
      console.error("[Singleton] failed to start lease heartbeat", error);
      await runtimeCoordinator.stop();
      return RUNTIME_EXIT_CODES.DATABASE_UNAVAILABLE;
    }
  }

  try {
    await client.login(process.env.NUVILOVIEW_BOT_TOKEN);
    return null;
  } catch (error) {
    updateRuntimeOperationalMetrics({ lastDiscordLoginFailureAt: new Date().toISOString() });
    runtimeCoordinator?.setStatus("Error", runtimeCoordinator.leaseState);
    await runtimeCoordinator?.recordNow({ status: "Error" });
    await runtimeCoordinator?.stop();
    throw error;
  }
}

const startupExitCode = await startBot();
if (startupExitCode != null) process.exit(startupExitCode);
