import {
  AttachmentBuilder,
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
  PermissionFlagsBits,
} from "discord.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  GuildResetError,
  assertConfirmationUsable,
  assertDeveloperGuildAccess,
  assertPlanUsable,
  assertSnapshotMatches,
  assertTargetsNotProtected,
  buildBackupDocument,
  buildDryRunItems,
  createSnapshotFingerprint,
  generateConfirmationCode,
  getConfirmationSecret,
  assertLockAvailable,
  getGuildResetConfig,
  getLimitState,
  hashConfirmationCode,
  hashGuildSnapshot,
  isDiscordId,
  isResetDeveloper,
  normalizeResetOptions,
  orderChannelTargets,
  orderRoleTargets,
  parseIdList,
  selectResetTargets,
  summarizeExecutionItems,
} from "./guild-reset-utils.mjs";

const BACKUP_SCHEMA_VERSION = 1;
const RESETTABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function json(value) {
  return JSON.stringify(value);
}

function safeError(error) {
  if (error instanceof GuildResetError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new GuildResetError(
    "INTERNAL_ERROR",
    "初期化処理に失敗しました。内部ログを確認してください。",
    { message: message.slice(0, 1_500), stack: error instanceof Error ? error.stack : null },
  );
  wrapped.cause = error;
  return wrapped;
}

function publicError(error) {
  const normalized = safeError(error);
  return {
    code: normalized.code,
    message: normalized.publicMessage,
  };
}

function formatTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function serializePermissionOverwrite(overwrite) {
  return {
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  };
}

function serializeChannel(channel) {
  const permissionOverwrites = channel.permissionOverwrites?.cache
    ? [...channel.permissionOverwrites.cache.values()]
        .map(serializePermissionOverwrite)
        .sort((left, right) => left.id.localeCompare(right.id))
    : [];
  return {
    oldChannelId: channel.id,
    name: channel.name,
    type: channel.type,
    typeName: ChannelType[channel.type] ?? String(channel.type),
    parentId: channel.parentId ?? null,
    position: Number(channel.rawPosition ?? channel.position ?? 0),
    topic: "topic" in channel ? channel.topic ?? null : null,
    nsfw: "nsfw" in channel ? Boolean(channel.nsfw) : false,
    slowmode: "rateLimitPerUser" in channel ? Number(channel.rateLimitPerUser ?? 0) : 0,
    bitrate: "bitrate" in channel ? Number(channel.bitrate ?? 0) : null,
    userLimit: "userLimit" in channel ? Number(channel.userLimit ?? 0) : null,
    permissionOverwrites,
    createdAt: channel.createdAt?.toISOString?.() ?? null,
    resetCandidate: RESETTABLE_CHANNEL_TYPES.has(channel.type),
    resetEligible: RESETTABLE_CHANNEL_TYPES.has(channel.type) && channel.deletable === true,
  };
}

function serializeRole(role) {
  return {
    oldRoleId: role.id,
    name: role.name,
    position: role.position,
    permissions: role.permissions.bitfield.toString(),
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    managed: role.managed,
    tags: role.tags ?? null,
    createdAt: role.createdAt?.toISOString?.() ?? null,
  };
}

function mergeLimits(config, settings) {
  return {
    maxChannelDeletes: settings.maxChannelDeletes ?? config.maxChannelDeletes,
    maxRoleDeletes: settings.maxRoleDeletes ?? config.maxRoleDeletes,
    maxTotalOperations: settings.maxTotalOperations ?? config.maxTotalOperations,
  };
}

function planResult(plan) {
  return {
    planId: plan.id,
    guildId: plan.guildId,
    guildName: plan.targetSummary.guild.name,
    mode: plan.mode,
    dryRun: plan.dryRun,
    summary: plan.targetSummary,
    expiresAt: plan.expiresAt,
  };
}

export function createGuildResetService({
  client,
  sql,
  isGuildBlocked,
  botVersion = "0.1.0",
  environment = process.env,
}) {
  const config = getGuildResetConfig(environment);
  const confirmationSecret = getConfirmationSecret(environment);

  function assertFeatureEnabled() {
    if (!config.enabled) {
      throw new GuildResetError(
        "FEATURE_DISABLED",
        "Guild初期化機能は現在無効です。",
      );
    }
    if (!confirmationSecret) {
      throw new GuildResetError(
        "CONFIRMATION_SECRET_MISSING",
        "確認コード用の署名鍵が設定されていません。",
      );
    }
  }

  async function getSettings(guildId) {
    const rows = await sql`
      SELECT
        "guildId", "enabled", "protectedChannelIds", "protectedRoleIds",
        "resetLogChannelId", "backupChannelId", "allowedAdminIds",
        "maxChannelDeletes", "maxRoleDeletes", "maxTotalOperations",
        "guildCooldownHours", "developerCooldownMinutes", "defaultMode",
        "createdAt", "updatedAt"
      FROM "guild_reset_settings"
      WHERE "guildId" = ${guildId}
      LIMIT 1
    `;
    const row = rows[0];
    return {
      guildId,
      enabled: row?.enabled === true,
      protectedChannelIds: parseIdList(row?.protectedChannelIds),
      protectedRoleIds: parseIdList(row?.protectedRoleIds),
      resetLogChannelId: isDiscordId(row?.resetLogChannelId) ? row.resetLogChannelId : null,
      backupChannelId: isDiscordId(row?.backupChannelId) ? row.backupChannelId : null,
      allowedAdminIds: parseIdList(row?.allowedAdminIds),
      maxChannelDeletes: Number.isInteger(row?.maxChannelDeletes) ? row.maxChannelDeletes : null,
      maxRoleDeletes: Number.isInteger(row?.maxRoleDeletes) ? row.maxRoleDeletes : null,
      maxTotalOperations: Number.isInteger(row?.maxTotalOperations) ? row.maxTotalOperations : null,
      guildCooldownHours: Number.isInteger(row?.guildCooldownHours) ? row.guildCooldownHours : null,
      developerCooldownMinutes: Number.isInteger(row?.developerCooldownMinutes) ? row.developerCooldownMinutes : null,
      defaultMode: row?.defaultMode ?? "channels_only",
    };
  }

  async function getGuildAndAuthorize(guildId, developerId) {
    assertFeatureEnabled();
    if (!isDiscordId(guildId)) {
      throw new GuildResetError("INVALID_GUILD_ID", "Guild IDの形式が正しくありません。");
    }
    if (!isResetDeveloper(developerId, environment)) {
      throw new GuildResetError("DEVELOPER_FORBIDDEN", "開発者権限がありません。");
    }
    if (isGuildBlocked(guildId)) {
      throw new GuildResetError("GUILD_BLOCKED", "ブロック中のGuildでは実行できません。");
    }
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      throw new GuildResetError("GUILD_NOT_FOUND", "対象Guildを確認できません。");
    }
    const settings = await getSettings(guildId);
    if (!settings.enabled) {
      throw new GuildResetError(
        "GUILD_RESET_DISABLED",
        "対象Guildでは初期化機能が有効化されていません。",
      );
    }
    assertDeveloperGuildAccess({
      developerId,
      ownerId: guild.ownerId,
      allowedAdminIds: settings.allowedAdminIds,
      environment,
    });
    return { guild, settings };
  }

  async function snapshotGuild(guild) {
    const [channelsCollection, rolesCollection, owner, botMember] = await Promise.all([
      guild.channels.fetch(),
      guild.roles.fetch(),
      guild.fetchOwner(),
      guild.members.fetchMe(),
    ]);
    const channels = [...channelsCollection.values()]
      .filter(Boolean)
      .map(serializeChannel)
      .sort((left, right) => left.position - right.position || left.oldChannelId.localeCompare(right.oldChannelId));
    const roles = [...rolesCollection.values()]
      .filter(Boolean)
      .map(serializeRole)
      .sort((left, right) => left.position - right.position || left.oldRoleId.localeCompare(right.oldRoleId));

    let botAssignedRoleIds = [];
    try {
      const members = await guild.members.fetch();
      botAssignedRoleIds = [
        ...new Set(
          [...members.values()]
            .filter((member) => member.user.bot)
            .flatMap((member) => [...member.roles.cache.keys()]),
        ),
      ];
    } catch {
      botAssignedRoleIds = [...botMember.roles.cache.keys()];
    }

    const administratorRoleIds = [...rolesCollection.values()]
      .filter((role) => role && role.permissions.has(PermissionFlagsBits.Administrator))
      .map((role) => role.id);

    return {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      guild: {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        owner: {
          id: owner.id,
          username: owner.user.username,
          displayName: owner.displayName,
        },
        memberCount: guild.memberCount,
        iconUrl: guild.iconURL({ extension: "png", size: 1024 }) ?? null,
        createdAt: guild.createdAt.toISOString(),
        settings: {
          systemChannelId: guild.systemChannelId,
          afkChannelId: guild.afkChannelId,
          afkTimeout: guild.afkTimeout,
          rulesChannelId: guild.rulesChannelId,
          publicUpdatesChannelId: guild.publicUpdatesChannelId,
          defaultMessageNotifications: guild.defaultMessageNotifications,
          verificationLevel: guild.verificationLevel,
          explicitContentFilter: guild.explicitContentFilter,
        },
      },
      channels,
      roles,
      dependency: {
        botRoleId: botMember.roles.botRole?.id ?? botMember.roles.highest.id,
        botHighestRolePosition: botMember.roles.highest.position,
        botAssignedRoleIds,
        administratorRoleIds,
      },
    };
  }

  function getMissingPermissions(botMember, options) {
    const missing = [];
    if (options.deleteChannels && !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      missing.push("ManageChannels");
    }
    if (options.deleteRoles && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      missing.push("ManageRoles");
    }
    if (options.resetSettings && !botMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
      missing.push("ManageGuild");
    }
    return missing;
  }

  async function buildPlan({ guild, settings, developerId, developerName, input, source }) {
    const options = normalizeResetOptions({
      mode: input.mode ?? settings.defaultMode,
      ...input,
    });
    const snapshot = await snapshotGuild(guild);
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    const missingPermissions = getMissingPermissions(botMember, options);
    const targets = selectResetTargets({
      snapshot,
      options,
      settings,
      ...snapshot.dependency,
    });
    const undeletableChannels = snapshot.channels.filter(
      (channel) => channel.resetCandidate && !channel.resetEligible,
    );
    const protectedChannelMap = new Map(
      [...targets.protectedChannels, ...undeletableChannels].map((channel) => [
        channel.oldChannelId,
        channel,
      ]),
    );
    const settingsChanges = options.resetSettings
      ? [
          "systemChannel",
          "afkChannel",
          "afkTimeout",
          "rulesChannel",
          "publicUpdatesChannel",
          "defaultMessageNotifications",
          "verificationLevel",
          "explicitContentFilter",
        ]
      : [];
    const createCount = options.createDefaultChannels ? 3 : 0;
    const totalOperationCount =
      targets.channels.length + targets.roles.length + settingsChanges.length + createCount;
    const limits = mergeLimits(config, settings);
    const limitState = getLimitState(
      {
        channelDeleteCount: targets.channels.length,
        roleDeleteCount: targets.roles.length,
        totalOperationCount,
      },
      limits,
    );
    const fingerprint = {
      guild: createSnapshotFingerprint(snapshot),
      resetSettings: {
        protectedChannelIds: settings.protectedChannelIds,
        protectedRoleIds: settings.protectedRoleIds,
        resetLogChannelId: settings.resetLogChannelId,
        backupChannelId: settings.backupChannelId,
        allowedAdminIds: settings.allowedAdminIds,
        limits,
      },
      requestedOptions: options,
    };
    const targetSnapshotHash = hashGuildSnapshot(fingerprint);
    const now = new Date();
    const plan = {
      id: randomUUID(),
      guildId: guild.id,
      developerId,
      developerName: developerName ?? null,
      mode: options.mode,
      dryRun: options.dryRun,
      requestedOptions: options,
      targetSnapshotHash,
      targetSummary: {
        guild: {
          id: guild.id,
          name: guild.name,
          ownerId: guild.ownerId,
          ownerName: snapshot.guild.owner.displayName,
          memberCount: guild.memberCount,
          channelCount: snapshot.channels.length,
          roleCount: snapshot.roles.length,
        },
        deleteChannels: targets.channels.map((channel) => ({
          id: channel.oldChannelId,
          name: channel.name,
          type: channel.typeName,
          parentId: channel.parentId,
          position: channel.position,
        })),
        protectedChannels: [...protectedChannelMap.values()].map((channel) => ({
          id: channel.oldChannelId,
          name: channel.name,
          type: channel.typeName,
        })),
        deleteRoles: targets.roles.map((role) => ({
          id: role.oldRoleId,
          name: role.name,
          position: role.position,
        })),
        protectedRoles: targets.protectedRoles.map((role) => ({
          id: role.oldRoleId,
          name: role.name,
          position: role.position,
        })),
        protectedChannelIds: targets.protectedChannelIds,
        protectedRoleIds: targets.protectedRoleIds,
        settingsChanges,
        createDefaultChannels: options.createDefaultChannels,
        channelDeleteCount: targets.channels.length,
        roleDeleteCount: targets.roles.length,
        totalOperationCount,
        limits,
        limitExceeded: limitState.exceeded,
        limitReasons: limitState.reasons,
        missingPermissions,
        warnings: [
          ...(options.deleteRoles
            ? ["ロール削除が有効です。ロール階層と連携機能に影響する可能性があります。"]
            : []),
          ...(options.resetSettings
            ? ["Guild主要設定の初期化が有効です。Guild名・アイコン・所有者には触れません。"]
            : []),
          ...(options.dryRun ? ["Dry RunのためDiscord上のデータは変更されません。"] : []),
          "バックアップは復元用情報を保持しますが、完全な自動復元を保証するものではありません。",
        ],
      },
      expiresAt: new Date(now.getTime() + config.planExpiresMinutes * 60_000).toISOString(),
      source,
    };

    await sql`
      INSERT INTO "guild_reset_plan" (
        "id", "guildId", "developerId", "developerName", "mode", "dryRun",
        "requestedOptions", "targetSnapshotHash", "targetSummary", "status",
        "expiresAt", "createdAt"
      )
      VALUES (
        ${plan.id}, ${plan.guildId}, ${plan.developerId}, ${plan.developerName},
        ${plan.mode}, ${plan.dryRun}, ${json(plan.requestedOptions)}::jsonb,
        ${plan.targetSnapshotHash}, ${json(plan.targetSummary)}::jsonb,
        'active', ${plan.expiresAt}, now()
      )
    `;
    return plan;
  }

  async function createPlan({ guildId, developerId, developerName, input = {}, source = "bot_command" }) {
    const { guild, settings } = await getGuildAndAuthorize(guildId, developerId);
    return buildPlan({ guild, settings, developerId, developerName, input, source });
  }

  async function getActivePlan(planId, guildId, developerId) {
    const rows = await sql`
      SELECT
        "id", "guildId", "developerId", "developerName", "mode", "dryRun",
        "requestedOptions", "targetSnapshotHash", "targetSummary", "status",
        "expiresAt", "createdAt", "usedAt"
      FROM "guild_reset_plan"
      WHERE "id" = ${planId}
      LIMIT 1
    `;
    const plan = rows[0];
    assertPlanUsable(plan, { guildId, developerId });
    return plan;
  }

  async function issueCode({ planId, guildId, developerId }) {
    assertFeatureEnabled();
    if (!guildId) {
      const rows = await sql`
        SELECT "guildId"
        FROM "guild_reset_plan"
        WHERE "id" = ${planId} AND "developerId" = ${developerId}
        LIMIT 1
      `;
      guildId = rows[0]?.guildId ?? null;
    }
    if (!guildId) throw new GuildResetError("PLAN_NOT_FOUND", "Planが存在しません。");
    const plan = await getActivePlan(planId, guildId, developerId);
    await getGuildAndAuthorize(guildId, developerId);
    const code = generateConfirmationCode();
    const confirmationId = randomUUID();
    const expiresAt = new Date(Date.now() + config.codeExpiresMinutes * 60_000).toISOString();
    const codeHash = hashConfirmationCode({
      code,
      planId,
      guildId,
      developerId,
      secret: confirmationSecret,
    });
    await sql`
      UPDATE "guild_reset_confirmation"
      SET "usedAt" = now()
      WHERE "planId" = ${planId} AND "usedAt" IS NULL
    `;
    await sql`
      INSERT INTO "guild_reset_confirmation" (
        "id", "planId", "guildId", "developerId", "codeHash",
        "expiresAt", "createdAt"
      )
      VALUES (
        ${confirmationId}, ${planId}, ${guildId}, ${developerId},
        ${codeHash}, ${expiresAt}, now()
      )
    `;
    return { plan: planResult(plan), confirmationId, code, expiresAt };
  }

  async function getPlanGuildId(planId, developerId) {
    assertFeatureEnabled();
    const rows = await sql`
      SELECT "guildId"
      FROM "guild_reset_plan"
      WHERE "id" = ${planId} AND "developerId" = ${developerId}
      LIMIT 1
    `;
    const guildId = rows[0]?.guildId;
    if (!guildId) throw new GuildResetError("PLAN_NOT_FOUND", "Planが存在しません。");
    return guildId;
  }

  async function consumeDiscordCode({ plan, code }) {
    if (!/^\d{6,12}$/.test(String(code))) {
      throw new GuildResetError("CODE_INVALID", "確認コードが正しくありません。");
    }
    const codeHash = hashConfirmationCode({
      code: String(code),
      planId: plan.id,
      guildId: plan.guildId,
      developerId: plan.developerId,
      secret: confirmationSecret,
    });
    const rows = await sql`
      UPDATE "guild_reset_confirmation"
      SET "usedAt" = now()
      WHERE "id" = (
        SELECT "id"
        FROM "guild_reset_confirmation"
        WHERE
          "planId" = ${plan.id}
          AND "guildId" = ${plan.guildId}
          AND "developerId" = ${plan.developerId}
          AND "codeHash" = ${codeHash}
          AND "usedAt" IS NULL
          AND "expiresAt" > now()
        ORDER BY "createdAt" DESC
        LIMIT 1
      )
      AND "usedAt" IS NULL
      RETURNING "id"
    `;
    if (!rows[0]) {
      throw new GuildResetError("CODE_INVALID", "確認コードが正しくないか、有効期限が切れています。");
    }
    return rows[0].id;
  }

  async function validateDashboardConfirmation({ plan, confirmationId, requestId }) {
    const rows = await sql`
      SELECT "id", "planId", "guildId", "developerId", "expiresAt", "usedAt", "usedByRequestId"
      FROM "guild_reset_confirmation"
      WHERE "id" = ${confirmationId}
      LIMIT 1
    `;
    const confirmation = rows[0];
    assertConfirmationUsable(confirmation, {
      planId: plan.id,
      guildId: plan.guildId,
      developerId: plan.developerId,
      requestId,
    });
    if (!confirmation.usedAt) {
      throw new GuildResetError("CODE_INVALID", "確認コードの検証状態を確認できません。");
    }
    return confirmation.id;
  }

  async function acquireLocks(guildId, executionId) {
    const expiresAt = new Date(Date.now() + config.lockExpiresMinutes * 60_000).toISOString();
    await sql`DELETE FROM "guild_reset_lock" WHERE "expiresAt" <= now()`;
    const globalRows = await sql`
      INSERT INTO "guild_reset_lock" ("scope", "guildId", "executionId", "expiresAt")
      VALUES ('global', ${guildId}, ${executionId}, ${expiresAt})
      ON CONFLICT ("scope") DO NOTHING
      RETURNING "scope"
    `;
    assertLockAvailable(Boolean(globalRows[0]));
    const guildRows = await sql`
      INSERT INTO "guild_reset_lock" ("scope", "guildId", "executionId", "expiresAt")
      VALUES (${`guild:${guildId}`}, ${guildId}, ${executionId}, ${expiresAt})
      ON CONFLICT ("scope") DO NOTHING
      RETURNING "scope"
    `;
    if (!guildRows[0]) {
      await sql`
        DELETE FROM "guild_reset_lock"
        WHERE "scope" = 'global' AND "executionId" = ${executionId}
      `;
      assertLockAvailable(false, "同一Guildでほかの初期化処理が実行中です。");
    }
  }

  async function releaseLocks(executionId) {
    await sql`DELETE FROM "guild_reset_lock" WHERE "executionId" = ${executionId}`;
  }

  async function assertCooldowns({ guildId, developerId, settings, dryRun }) {
    if (dryRun) return;
    const guildHours = settings.guildCooldownHours ?? config.guildCooldownHours;
    const developerMinutes =
      settings.developerCooldownMinutes ?? config.developerCooldownMinutes;
    const guildRows = await sql`
      SELECT "startedAt"
      FROM "guild_reset_execution"
      WHERE
        "guildId" = ${guildId}
        AND "dryRun" = false
        AND "operationStarted" = true
        AND "startedAt" > now() - (${guildHours} * interval '1 hour')
      ORDER BY "startedAt" DESC
      LIMIT 1
    `;
    if (guildRows[0]) {
      throw new GuildResetError(
        "GUILD_COOLDOWN",
        `同一Guildのクールダウン中です（${guildHours}時間）。`,
      );
    }
    const developerRows = await sql`
      SELECT "startedAt"
      FROM "guild_reset_execution"
      WHERE
        "developerId" = ${developerId}
        AND "dryRun" = false
        AND "operationStarted" = true
        AND "startedAt" > now() - (${developerMinutes} * interval '1 minute')
      ORDER BY "startedAt" DESC
      LIMIT 1
    `;
    if (developerRows[0]) {
      throw new GuildResetError(
        "DEVELOPER_COOLDOWN",
        `開発者クールダウン中です（${developerMinutes}分）。`,
      );
    }
  }

  async function createBackupFile({ snapshot, plan, executionId, developerId, developerName }) {
    const createdAt = new Date();
    const fileName = `guild-backup-${plan.guildId}-${formatTimestampForFile(createdAt)}.json`;
    const baseDirectory = resolve(config.backupDirectory);
    const guildDirectory = join(baseDirectory, plan.guildId);
    const filePath = join(guildDirectory, fileName);
    if (dirname(filePath) !== guildDirectory) {
      throw new GuildResetError("BACKUP_PATH_INVALID", "バックアップ保存先を確認できません。");
    }
    const payload = buildBackupDocument({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: createdAt.toISOString(),
      botVersion,
      executionId,
      developerId,
      developerName,
      plan,
      snapshot,
    });
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    await mkdir(guildDirectory, { recursive: true });
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    const verified = await readFile(filePath);
    const checksum = createHash("sha256").update(verified).digest("hex");
    return {
      id: randomUUID(),
      fileName,
      filePath,
      fileSize: verified.byteLength,
      checksum,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      payload,
    };
  }

  async function recordExecutionItem(executionId, item) {
    const errorMessage = item.errorMessage?.slice(0, 1_500) ?? null;
    await sql`
      INSERT INTO "guild_reset_execution_item" (
        "executionId", "targetType", "targetId", "targetName",
        "action", "status", "errorCode", "errorMessage"
      )
      VALUES (
        ${executionId}, ${item.targetType}, ${item.targetId ?? null},
        ${item.targetName ?? null}, ${item.action}, ${item.status},
        ${item.errorCode ?? null}, ${errorMessage}
      )
    `;
  }

  async function writeAuditFile(execution) {
    const directory = resolve(config.backupDirectory, execution.guildId, "audit");
    const path = join(directory, `guild-reset-audit-${execution.id}.json`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, `${JSON.stringify(execution, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return path;
  }

  async function notifyLogChannel(guild, settings, message, attachmentPath = null) {
    if (!settings.resetLogChannelId) return;
    const channel = await guild.channels.fetch(settings.resetLogChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.isSendable?.()) return;
    const payload = {
      content: message.slice(0, 1_900),
      allowedMentions: { parse: [] },
    };
    if (attachmentPath) {
      payload.files = [new AttachmentBuilder(attachmentPath)];
    }
    await channel.send(payload);
  }

  async function sendBackupToChannel(guild, settings, backup) {
    if (!settings.backupChannelId) return;
    const channel = await guild.channels.fetch(settings.backupChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.isSendable?.()) return;
    await channel.send({
      content: `Guild初期化バックアップ · Plan \`${backup.payload.plan.id}\``,
      files: [new AttachmentBuilder(backup.filePath, { name: backup.fileName })],
      allowedMentions: { parse: [] },
    });
  }

  async function performOperations({ guild, settings, plan, executionId }) {
    const options = plan.requestedOptions;
    const targetSummary = plan.targetSummary;
    const protectedChannelIds = new Set(targetSummary.protectedChannelIds ?? []);
    const protectedRoleIds = new Set(targetSummary.protectedRoleIds ?? []);
    assertTargetsNotProtected(
      targetSummary.deleteChannels.map((target) => target.id),
      [...protectedChannelIds],
      "チャンネル",
    );
    assertTargetsNotProtected(
      targetSummary.deleteRoles.map((target) => target.id),
      [...protectedRoleIds],
      "ロール",
    );
    const items = [];
    const addItem = async (item) => {
      items.push(item);
      await recordExecutionItem(executionId, item);
    };

    if (plan.dryRun) {
      for (const target of buildDryRunItems(targetSummary, options)) {
        await addItem(target);
      }
      return items;
    }

    await sql`
      UPDATE "guild_reset_execution"
      SET "operationStarted" = true
      WHERE "id" = ${executionId}
    `;

    const channelTargets = orderChannelTargets(targetSummary.deleteChannels);
    for (const target of channelTargets) {
      if (protectedChannelIds.has(target.id)) {
        throw new GuildResetError(
          "PROTECTED_TARGET",
          "保護対象のチャンネルが削除対象に含まれたため中止しました。",
          { targetId: target.id },
        );
      }
      const channel = await guild.channels.fetch(target.id).catch(() => null);
      if (!channel) {
        await addItem({
          targetType: "channel",
          targetId: target.id,
          targetName: target.name,
          action: "delete",
          status: "failed",
          errorCode: "TARGET_NOT_FOUND",
          errorMessage: "Plan作成後にチャンネルが見つからなくなりました。",
        });
        continue;
      }
      try {
        await channel.delete(`Guild reset plan ${plan.id}: ${options.reason}`);
        await addItem({
          targetType: "channel",
          targetId: target.id,
          targetName: target.name,
          action: "delete",
          status: "success",
        });
      } catch (error) {
        await addItem({
          targetType: "channel",
          targetId: target.id,
          targetName: target.name,
          action: "delete",
          status: "failed",
          errorCode: String(error?.code ?? "DISCORD_API_ERROR"),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const roleTargets = orderRoleTargets(targetSummary.deleteRoles);
    for (const target of roleTargets) {
      if (protectedRoleIds.has(target.id) || target.id === guild.id) {
        throw new GuildResetError(
          "PROTECTED_TARGET",
          "保護対象のロールが削除対象に含まれたため中止しました。",
          { targetId: target.id },
        );
      }
      const role = await guild.roles.fetch(target.id).catch(() => null);
      if (!role) {
        await addItem({
          targetType: "role",
          targetId: target.id,
          targetName: target.name,
          action: "delete",
          status: "failed",
          errorCode: "TARGET_NOT_FOUND",
          errorMessage: "Plan作成後にロールが見つからなくなりました。",
        });
        continue;
      }
      if (role.managed || !role.editable || role.permissions.has(PermissionFlagsBits.Administrator)) {
        throw new GuildResetError(
          "PROTECTED_TARGET",
          "実行時に保護対象となったロールを検出したため中止しました。",
          { targetId: target.id },
        );
      }
      try {
        await role.delete(`Guild reset plan ${plan.id}: ${options.reason}`);
        await addItem({
          targetType: "role",
          targetId: target.id,
          targetName: target.name,
          action: "delete",
          status: "success",
        });
      } catch (error) {
        await addItem({
          targetType: "role",
          targetId: target.id,
          targetName: target.name,
          action: "delete",
          status: "failed",
          errorCode: String(error?.code ?? "DISCORD_API_ERROR"),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (options.resetSettings) {
      try {
        await guild.edit({
          systemChannel: null,
          afkChannel: null,
          afkTimeout: 300,
          rulesChannel: null,
          publicUpdatesChannel: null,
          defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
          verificationLevel: GuildVerificationLevel.Low,
          explicitContentFilter: GuildExplicitContentFilter.AllMembers,
          reason: `Guild reset plan ${plan.id}: ${options.reason}`,
        });
        for (const setting of targetSummary.settingsChanges) {
          await addItem({
            targetType: "guild_setting",
            targetId: null,
            targetName: setting,
            action: "reset",
            status: "success",
          });
        }
      } catch (error) {
        for (const setting of targetSummary.settingsChanges) {
          await addItem({
            targetType: "guild_setting",
            targetId: null,
            targetName: setting,
            action: "reset",
            status: "failed",
            errorCode: String(error?.code ?? "DISCORD_API_ERROR"),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (options.createDefaultChannels) {
      for (const name of ["general", "logs", "rules"]) {
        try {
          const created = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            reason: `Guild reset plan ${plan.id}: requested default channel`,
          });
          await addItem({
            targetType: "channel",
            targetId: created.id,
            targetName: name,
            action: "create",
            status: "success",
          });
        } catch (error) {
          await addItem({
            targetType: "channel",
            targetId: null,
            targetName: name,
            action: "create",
            status: "failed",
            errorCode: String(error?.code ?? "DISCORD_API_ERROR"),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return items;
  }

  async function executePlan({
    planId,
    guildId,
    developerId,
    developerName,
    code = null,
    confirmationId = null,
    requestId = null,
    source = "bot_command",
  }) {
    assertFeatureEnabled();
    const plan = await getActivePlan(planId, guildId, developerId);
    const { guild, settings } = await getGuildAndAuthorize(guildId, developerId);
    if (requestId) {
      await validateDashboardConfirmation({ plan, confirmationId, requestId });
    } else {
      confirmationId = await consumeDiscordCode({ plan, code });
    }

    const executionId = randomUUID();
    let lockAcquired = false;
    let executionRecorded = false;
    let backup = null;
    let items = [];
    try {
      await acquireLocks(guildId, executionId);
      lockAcquired = true;
      await assertCooldowns({
        guildId,
        developerId,
        settings,
        dryRun: plan.dryRun,
      });

      const botMember = guild.members.me ?? (await guild.members.fetchMe());
      const options = normalizeResetOptions(plan.requestedOptions);
      const missingPermissions = getMissingPermissions(botMember, options);
      if (missingPermissions.length > 0) {
        throw new GuildResetError(
          "BOT_PERMISSION_MISSING",
          `Botの権限が不足しています: ${missingPermissions.join(", ")}`,
        );
      }

      const currentSnapshot = await snapshotGuild(guild);
      const currentFingerprint = {
        guild: createSnapshotFingerprint(currentSnapshot),
        resetSettings: {
          protectedChannelIds: settings.protectedChannelIds,
          protectedRoleIds: settings.protectedRoleIds,
          resetLogChannelId: settings.resetLogChannelId,
          backupChannelId: settings.backupChannelId,
          allowedAdminIds: settings.allowedAdminIds,
          limits: mergeLimits(config, settings),
        },
        requestedOptions: options,
      };
      const currentHash = hashGuildSnapshot(currentFingerprint);
      assertSnapshotMatches(plan.targetSnapshotHash, currentHash);

      const limitState = getLimitState(plan.targetSummary, mergeLimits(config, settings));
      if (limitState.exceeded) {
        throw new GuildResetError(
          "LIMIT_EXCEEDED",
          `実行上限を超えています: ${limitState.reasons.join("、")}`,
        );
      }

      backup = await createBackupFile({
        snapshot: currentSnapshot,
        plan,
        executionId,
        developerId,
        developerName,
      }).catch((error) => {
        throw new GuildResetError(
          "BACKUP_FAILED",
          "バックアップ作成に失敗したため中止しました。",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      });

      await sql`
        INSERT INTO "guild_reset_execution" (
          "id", "planId", "guildId", "developerId", "developerName",
          "mode", "dryRun", "reason", "source", "status", "backupPath",
          "requestedCount", "beforeSummary", "startedAt"
        )
        VALUES (
          ${executionId}, ${plan.id}, ${guildId}, ${developerId},
          ${developerName ?? plan.developerName ?? null}, ${plan.mode},
          ${plan.dryRun}, ${options.reason}, ${source}, 'running',
          ${backup.filePath}, ${plan.targetSummary.totalOperationCount},
          ${json({
            channelCount: currentSnapshot.channels.length,
            roleCount: currentSnapshot.roles.length,
            memberCount: currentSnapshot.guild.memberCount,
          })}::jsonb, now()
        )
      `;
      executionRecorded = true;
      await sql`
        INSERT INTO "guild_reset_backup" (
          "id", "executionId", "planId", "guildId", "fileName", "filePath",
          "fileSize", "checksum", "schemaVersion"
        )
        VALUES (
          ${backup.id}, ${executionId}, ${plan.id}, ${guildId},
          ${backup.fileName}, ${backup.filePath}, ${backup.fileSize},
          ${backup.checksum}, ${backup.schemaVersion}
        )
      `;

      await sendBackupToChannel(guild, settings, backup).catch((error) =>
        console.error("Guild reset backup channel delivery failed:", error),
      );

      const usedRows = await sql`
        UPDATE "guild_reset_plan"
        SET "status" = 'used', "usedAt" = now()
        WHERE "id" = ${plan.id} AND "status" = 'active' AND "usedAt" IS NULL
        RETURNING "id"
      `;
      if (!usedRows[0]) {
        throw new GuildResetError("PLAN_ALREADY_USED", "このPlanはすでに使用済みです。");
      }

      items = await performOperations({ guild, settings, plan, executionId });
      const counts = summarizeExecutionItems(items);
      const afterSnapshot = await snapshotGuild(guild);
      const status = counts.failedCount > 0 ? "partial" : "completed";
      await sql`
        UPDATE "guild_reset_execution"
        SET
          "status" = ${status},
          "successCount" = ${counts.successCount},
          "failedCount" = ${counts.failedCount},
          "skippedCount" = ${counts.skippedCount},
          "afterSummary" = ${json({
            channelCount: afterSnapshot.channels.length,
            roleCount: afterSnapshot.roles.length,
            memberCount: afterSnapshot.guild.memberCount,
          })}::jsonb,
          "finishedAt" = now()
        WHERE "id" = ${executionId}
      `;
      const result = {
        executionId,
        planId: plan.id,
        guildId,
        guildName: guild.name,
        mode: plan.mode,
        dryRun: plan.dryRun,
        status,
        backupPath: backup.filePath,
        backupFileName: backup.fileName,
        ...counts,
        requestedCount: plan.targetSummary.totalOperationCount,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        targets: {
          deleted: plan.targetSummary.deleteChannels,
          roles: plan.targetSummary.deleteRoles,
          protectedChannels: plan.targetSummary.protectedChannels,
          protectedRoles: plan.targetSummary.protectedRoles,
        },
        items,
      };
      const auditPath = await writeAuditFile(result).catch((error) => {
        console.error("Guild reset JSON audit write failed:", error);
        return null;
      });
      result.auditPath = auditPath;
      await notifyLogChannel(
        guild,
        settings,
        [
          `Guild初期化${plan.dryRun ? " Dry Run" : ""}が完了しました。`,
          `Plan: \`${plan.id}\``,
          `Execution: \`${executionId}\``,
          `成功 ${counts.successCount} / 失敗 ${counts.failedCount} / スキップ ${counts.skippedCount}`,
        ].join("\n"),
      ).catch((error) =>
        console.error("Guild reset log channel notification failed:", error),
      );
      return result;
    } catch (error) {
      const normalized = safeError(error);
      if (executionRecorded) {
        const counts = summarizeExecutionItems(items);
        await sql`
          UPDATE "guild_reset_execution"
          SET
            "status" = 'failed',
            "successCount" = ${counts.successCount},
            "failedCount" = ${counts.failedCount},
            "skippedCount" = ${counts.skippedCount},
            "errorSummary" = ${`${normalized.code}: ${normalized.message}`.slice(0, 1_500)},
            "finishedAt" = now()
          WHERE "id" = ${executionId}
        `.catch(() => {});
      }
      console.error("Guild reset execution failed:", {
        executionId,
        planId,
        guildId,
        developerId,
        code: normalized.code,
        details: normalized.details,
        stack: normalized.stack,
      });
      throw normalized;
    } finally {
      if (lockAcquired) {
        await releaseLocks(executionId).catch((error) =>
          console.error("Guild reset lock release failed:", error),
        );
      }
    }
  }

  async function claimDashboardRequest() {
    const rows = await sql`
      WITH stale AS (
        UPDATE "guild_reset_request"
        SET "status" = 'queued', "claimedAt" = NULL
        WHERE "status" = 'running' AND "claimedAt" < now() - interval '15 minutes'
      ),
      candidate AS (
        SELECT "id"
        FROM "guild_reset_request"
        WHERE "status" = 'queued'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "guild_reset_request" AS request
      SET "status" = 'running', "claimedAt" = now()
      FROM candidate
      WHERE request."id" = candidate."id"
      RETURNING request.*
    `;
    return rows[0] ?? null;
  }

  async function processDashboardRequest() {
    if (!config.enabled) return null;
    const request = await claimDashboardRequest();
    if (!request) return null;
    try {
      let result;
      if (request.action === "plan") {
        result = planResult(
          await createPlan({
            guildId: request.guildId,
            developerId: request.developerId,
            developerName: request.developerName,
            input: request.payload,
            source: "developer_dashboard",
          }),
        );
      } else if (request.action === "confirm") {
        result = await executePlan({
          planId: request.payload.planId,
          guildId: request.guildId,
          developerId: request.developerId,
          developerName: request.developerName,
          confirmationId: request.confirmationId,
          requestId: request.id,
          source: "developer_dashboard",
        });
      } else {
        throw new GuildResetError("INVALID_REQUEST", "未対応の初期化リクエストです。");
      }
      await sql`
        UPDATE "guild_reset_request"
        SET
          "status" = 'completed',
          "result" = ${json(result)}::jsonb,
          "completedAt" = now()
        WHERE "id" = ${request.id}
      `;
      return result;
    } catch (error) {
      const output = publicError(error);
      await sql`
        UPDATE "guild_reset_request"
        SET
          "status" = 'failed',
          "errorCode" = ${output.code},
          "errorMessage" = ${output.message},
          "completedAt" = now()
        WHERE "id" = ${request.id}
      `;
      return output;
    }
  }

  return {
    config,
    createPlan,
    issueCode,
    getPlanGuildId,
    executePlan,
    processDashboardRequest,
    getSettings,
    publicError,
  };
}
