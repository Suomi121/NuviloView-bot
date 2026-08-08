import {
  createHash,
  createHmac,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

export const RESET_MODES = new Set([
  "channels_only",
  "channels_and_roles",
  "settings_reset",
]);

export class GuildResetError extends Error {
  constructor(code, publicMessage, details = null) {
    super(publicMessage);
    this.name = "GuildResetError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}

export function isDiscordId(value) {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

export function parseIdList(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(isDiscordId))];
}

export function parseDeveloperIds(environment = process.env) {
  return new Set([
    ...parseIdList(environment.GUILD_RESET_DEVELOPER_IDS),
    ...parseIdList(environment.DISCORD_OWNER_USER_ID),
  ]);
}

export function isResetDeveloper(userId, environment = process.env) {
  return isDiscordId(userId) && parseDeveloperIds(environment).has(userId);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, minimum), maximum)
    : fallback;
}

export function getGuildResetConfig(environment = process.env) {
  return {
    enabled: String(environment.GUILD_RESET_ENABLED ?? "false").toLowerCase() === "true",
    maxChannelDeletes: boundedInteger(environment.GUILD_RESET_MAX_CHANNEL_DELETES, 50, 0, 250),
    maxRoleDeletes: boundedInteger(environment.GUILD_RESET_MAX_ROLE_DELETES, 25, 0, 100),
    maxTotalOperations: boundedInteger(environment.GUILD_RESET_MAX_TOTAL_OPERATIONS, 75, 1, 350),
    guildCooldownHours: boundedInteger(environment.GUILD_RESET_GUILD_COOLDOWN_HOURS, 24, 0, 720),
    developerCooldownMinutes: boundedInteger(environment.GUILD_RESET_DEVELOPER_COOLDOWN_MINUTES, 60, 0, 10_080),
    planExpiresMinutes: boundedInteger(environment.GUILD_RESET_PLAN_EXPIRES_MINUTES, 10, 1, 60),
    codeExpiresMinutes: boundedInteger(environment.GUILD_RESET_CODE_EXPIRES_MINUTES, 5, 1, 15),
    backupDirectory: environment.GUILD_RESET_BACKUP_DIR?.trim() || "./data/backups/guild-reset",
    globalConcurrency: boundedInteger(environment.GUILD_RESET_GLOBAL_CONCURRENCY, 1, 1, 1),
    lockExpiresMinutes: boundedInteger(environment.GUILD_RESET_LOCK_EXPIRES_MINUTES, 30, 5, 180),
  };
}

export function normalizeResetOptions(input = {}) {
  const mode = RESET_MODES.has(input.mode) ? input.mode : "channels_only";
  const deleteChannels =
    mode === "settings_reset"
      ? input.deleteChannels === true
      : input.deleteChannels !== false;
  const deleteRoles = mode === "channels_and_roles" && input.deleteRoles === true;
  const resetSettings = mode === "settings_reset" && input.resetSettings === true;
  const createDefaultChannels = input.createDefaultChannels === true;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  if (mode === "channels_and_roles" && !deleteRoles) {
    throw new GuildResetError(
      "ROLE_DELETE_NOT_ACKNOWLEDGED",
      "ロール削除はdelete_rolesを明示的に有効化したPlanでのみ実行できます。",
    );
  }
  if (mode === "settings_reset" && !resetSettings) {
    throw new GuildResetError(
      "SETTINGS_RESET_NOT_ACKNOWLEDGED",
      "設定初期化はreset_settingsを明示的に有効化したPlanでのみ実行できます。",
    );
  }
  if (!deleteChannels && !deleteRoles && !resetSettings && !createDefaultChannels) {
    throw new GuildResetError("NO_OPERATIONS", "初期化対象が選択されていません。");
  }
  if (reason.length < 3) {
    throw new GuildResetError("REASON_REQUIRED", "3文字以上の実行理由が必要です。");
  }

  return {
    mode,
    dryRun: input.dryRun !== false,
    deleteChannels,
    deleteRoles,
    resetSettings,
    createDefaultChannels,
    keepChannelIds: parseIdList(input.keepChannelIds),
    keepRoleIds: parseIdList(input.keepRoleIds),
    reason,
  };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashGuildSnapshot(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function createSnapshotFingerprint(snapshot) {
  return {
    guildId: snapshot.guild.id,
    ownerId: snapshot.guild.ownerId,
    settings: snapshot.guild.settings,
    channels: snapshot.channels
      .map((channel) => ({
        id: channel.oldChannelId,
        type: channel.type,
        parentId: channel.parentId,
        position: channel.position,
        permissionOverwrites: channel.permissionOverwrites,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    roles: snapshot.roles
      .map((role) => ({
        id: role.oldRoleId,
        position: role.position,
        permissions: role.permissions,
        managed: role.managed,
        tags: role.tags,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function getConfirmationSecret(environment = process.env) {
  return (
    environment.GUILD_RESET_CONFIRMATION_SECRET?.trim() ||
    environment.AUDIT_LOG_SIGNING_SECRET?.trim() ||
    environment.BETTER_AUTH_SECRET?.trim() ||
    null
  );
}

export function generateConfirmationCode() {
  return String(randomInt(10_000_000, 100_000_000));
}

export function hashConfirmationCode({
  code,
  planId,
  guildId,
  developerId,
  secret,
}) {
  if (!secret) {
    throw new GuildResetError(
      "CONFIRMATION_SECRET_MISSING",
      "確認コード用の署名鍵が設定されていません。",
    );
  }
  return createHmac("sha256", secret)
    .update(["nuviloview-guild-reset-code-v1", planId, guildId, developerId, code].join("\n"))
    .digest("hex");
}

export function verifyConfirmationCode(input) {
  const expected = Buffer.from(hashConfirmationCode(input), "hex");
  const actualValue = typeof input.codeHash === "string" ? input.codeHash : "";
  if (!/^[a-f0-9]{64}$/i.test(actualValue)) return false;
  const actual = Buffer.from(actualValue, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getLimitState(summary, limits) {
  const channelCount = Number(summary.channelDeleteCount ?? 0);
  const roleCount = Number(summary.roleDeleteCount ?? 0);
  const totalCount = Number(summary.totalOperationCount ?? channelCount + roleCount);
  const reasons = [];
  if (channelCount > limits.maxChannelDeletes) {
    reasons.push(`チャンネル ${channelCount}/${limits.maxChannelDeletes}`);
  }
  if (roleCount > limits.maxRoleDeletes) {
    reasons.push(`ロール ${roleCount}/${limits.maxRoleDeletes}`);
  }
  if (totalCount > limits.maxTotalOperations) {
    reasons.push(`合計操作 ${totalCount}/${limits.maxTotalOperations}`);
  }
  return { exceeded: reasons.length > 0, reasons };
}

export function getCooldownRemaining({
  lastStartedAt,
  durationMilliseconds,
  dryRun = false,
  operationStarted = true,
  now = Date.now(),
}) {
  if (dryRun || !operationStarted || !lastStartedAt) return 0;
  const startedAt = new Date(lastStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, startedAt + durationMilliseconds - now);
}

export function assertLockAvailable(acquired, message = "現在ほかの初期化処理が実行中です。") {
  if (!acquired) throw new GuildResetError("LOCKED", message);
  return true;
}

export function isExpired(value, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp <= now;
}

export function assertPlanUsable(plan, { guildId, developerId, now = Date.now() }) {
  if (!plan) throw new GuildResetError("PLAN_NOT_FOUND", "Planが存在しません。");
  if (plan.guildId !== guildId) {
    throw new GuildResetError("PLAN_GUILD_MISMATCH", "PlanとGuildが一致しません。");
  }
  if (plan.developerId !== developerId) {
    throw new GuildResetError("PLAN_OWNER_MISMATCH", "Plan作成者と実行者が一致しません。");
  }
  if (plan.status !== "active" || plan.usedAt) {
    throw new GuildResetError("PLAN_ALREADY_USED", "このPlanはすでに使用済みです。");
  }
  if (isExpired(plan.expiresAt, now)) {
    throw new GuildResetError("PLAN_EXPIRED", "Planの有効期限が切れています。");
  }
  return true;
}

export function assertConfirmationUsable(
  confirmation,
  { planId, guildId, developerId, requestId = null, now = Date.now() },
) {
  if (!confirmation) {
    throw new GuildResetError("CODE_INVALID", "確認コードを確認できません。");
  }
  if (
    confirmation.planId !== planId ||
    confirmation.guildId !== guildId ||
    confirmation.developerId !== developerId
  ) {
    throw new GuildResetError("CODE_INVALID", "確認コードの紐付けが一致しません。");
  }
  if (confirmation.usedAt && (!requestId || confirmation.usedByRequestId !== requestId)) {
    throw new GuildResetError("CODE_ALREADY_USED", "確認コードはすでに使用済みです。");
  }
  if (requestId && confirmation.usedByRequestId !== requestId) {
    throw new GuildResetError("CODE_INVALID", "確認済みリクエストが一致しません。");
  }
  if (!confirmation.usedAt && isExpired(confirmation.expiresAt, now)) {
    throw new GuildResetError("CODE_EXPIRED", "確認コードの有効期限が切れています。");
  }
  return true;
}

export function assertSnapshotMatches(plannedHash, currentHash) {
  if (
    typeof plannedHash !== "string" ||
    typeof currentHash !== "string" ||
    plannedHash !== currentHash
  ) {
    throw new GuildResetError(
      "SNAPSHOT_CHANGED",
      "対象構成が変更されたため、新しいPlanが必要です。",
    );
  }
  return true;
}

export function assertTargetsNotProtected(targetIds, protectedIds, targetType) {
  const protectedSet = new Set(protectedIds);
  const conflict = targetIds.find((id) => protectedSet.has(id));
  if (conflict) {
    throw new GuildResetError(
      "PROTECTED_TARGET",
      `保護対象の${targetType}が削除対象に含まれたため中止しました。`,
      { targetId: conflict },
    );
  }
  return true;
}

export function orderChannelTargets(targets) {
  return [...targets].sort((left, right) => {
    const leftCategory = left.type === "GuildCategory";
    const rightCategory = right.type === "GuildCategory";
    if (leftCategory !== rightCategory) return leftCategory ? 1 : -1;
    const leftChild = Boolean(left.parentId);
    const rightChild = Boolean(right.parentId);
    if (leftChild !== rightChild) return leftChild ? -1 : 1;
    return Number(left.position) - Number(right.position);
  });
}

export function orderRoleTargets(targets) {
  return [...targets].sort(
    (left, right) => Number(left.position) - Number(right.position),
  );
}

export function buildDryRunItems(targetSummary, options) {
  return [
    ...targetSummary.deleteChannels.map((target) => ({
      targetType: "channel",
      targetId: target.id,
      targetName: target.name,
      action: "delete",
      status: "skipped",
      errorCode: "DRY_RUN",
    })),
    ...targetSummary.deleteRoles.map((target) => ({
      targetType: "role",
      targetId: target.id,
      targetName: target.name,
      action: "delete",
      status: "skipped",
      errorCode: "DRY_RUN",
    })),
    ...targetSummary.settingsChanges.map((target) => ({
      targetType: "guild_setting",
      targetId: null,
      targetName: target,
      action: "reset",
      status: "skipped",
      errorCode: "DRY_RUN",
    })),
    ...(options.createDefaultChannels
      ? ["general", "logs", "rules"].map((name) => ({
          targetType: "channel",
          targetId: null,
          targetName: name,
          action: "create",
          status: "skipped",
          errorCode: "DRY_RUN",
        }))
      : []),
  ];
}

export function buildBackupDocument({
  schemaVersion,
  createdAt,
  botVersion,
  executionId,
  developerId,
  developerName,
  plan,
  snapshot,
}) {
  return {
    schemaVersion,
    createdAt,
    botVersion,
    executionId,
    executor: { id: developerId, name: developerName ?? null },
    plan: {
      id: plan.id,
      guildId: plan.guildId,
      mode: plan.mode,
      dryRun: plan.dryRun,
      requestedOptions: plan.requestedOptions,
      targetSnapshotHash: plan.targetSnapshotHash,
      targetSummary: plan.targetSummary,
      expiresAt: plan.expiresAt,
    },
    ...snapshot,
  };
}

export async function requireBackupBeforeMutation(createBackup, mutation) {
  const backup = await createBackup();
  return mutation(backup);
}

export async function runWithRelease(work, release) {
  try {
    return await work();
  } finally {
    await release();
  }
}

export function assertDeveloperGuildAccess({
  developerId,
  ownerId,
  allowedAdminIds = [],
  environment = process.env,
}) {
  if (!isResetDeveloper(developerId, environment)) {
    throw new GuildResetError("DEVELOPER_FORBIDDEN", "開発者権限がありません。");
  }
  if (developerId !== ownerId && !parseIdList(allowedAdminIds).includes(developerId)) {
    throw new GuildResetError(
      "GUILD_CONTROL_FORBIDDEN",
      "対象Guildの所有者または明示的に許可された管理者ではありません。",
    );
  }
  return true;
}

export function selectResetTargets({
  snapshot,
  options,
  settings,
  botRoleId,
  botHighestRolePosition,
  botAssignedRoleIds = [],
  administratorRoleIds = [],
}) {
  const protectedChannelIds = new Set([
    ...parseIdList(settings.protectedChannelIds),
    ...parseIdList(options.keepChannelIds),
    ...parseIdList(settings.resetLogChannelId),
    ...parseIdList(settings.backupChannelId),
  ]);
  const protectedRoleIds = new Set([
    snapshot.guild.id,
    botRoleId,
    ...parseIdList(settings.protectedRoleIds),
    ...parseIdList(options.keepRoleIds),
    ...parseIdList(botAssignedRoleIds),
    ...parseIdList(administratorRoleIds),
  ].filter(Boolean));

  const protectedChannels = snapshot.channels.filter((channel) =>
    protectedChannelIds.has(channel.oldChannelId),
  );
  const channels = options.deleteChannels
    ? snapshot.channels.filter(
        (channel) =>
          channel.resetEligible === true &&
          !protectedChannelIds.has(channel.oldChannelId),
      )
    : [];

  const protectedRoles = snapshot.roles.filter(
    (role) =>
      protectedRoleIds.has(role.oldRoleId) ||
      role.managed ||
      role.position >= botHighestRolePosition,
  );
  const roles = options.deleteRoles
    ? snapshot.roles.filter(
        (role) =>
          !protectedRoleIds.has(role.oldRoleId) &&
          !role.managed &&
          role.position < botHighestRolePosition,
      )
    : [];

  return {
    channels,
    roles,
    protectedChannels,
    protectedRoles,
    protectedChannelIds: [...protectedChannelIds],
    protectedRoleIds: [...protectedRoleIds],
  };
}

export function summarizeExecutionItems(items) {
  return items.reduce(
    (summary, item) => {
      if (item.status === "success") summary.successCount += 1;
      else if (item.status === "failed") summary.failedCount += 1;
      else summary.skippedCount += 1;
      return summary;
    },
    { successCount: 0, failedCount: 0, skippedCount: 0 },
  );
}
