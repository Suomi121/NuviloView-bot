import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConfirmationUsable,
  assertDeveloperGuildAccess,
  assertLockAvailable,
  assertPlanUsable,
  assertSnapshotMatches,
  assertTargetsNotProtected,
  buildBackupDocument,
  buildDryRunItems,
  generateConfirmationCode,
  getCooldownRemaining,
  getLimitState,
  hashConfirmationCode,
  hashGuildSnapshot,
  isDiscordId,
  normalizeResetOptions,
  orderChannelTargets,
  orderRoleTargets,
  requireBackupBeforeMutation,
  runWithRelease,
  selectResetTargets,
  summarizeExecutionItems,
  verifyConfirmationCode,
} from "../lib/guild-reset-utils.mjs";

const developerId = "111111111111111111";
const otherDeveloperId = "222222222222222222";
const guildId = "333333333333333333";
const environment = {
  GUILD_RESET_DEVELOPER_IDS: `${developerId},${otherDeveloperId}`,
};

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

function activePlan(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    guildId,
    developerId,
    status: "active",
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function confirmation(overrides = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    planId: activePlan().id,
    guildId,
    developerId,
    usedAt: null,
    usedByRequestId: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function snapshot() {
  return {
    guild: { id: guildId },
    channels: [
      { oldChannelId: "400000000000000001", name: "general", resetEligible: true },
      { oldChannelId: "400000000000000002", name: "logs", resetEligible: true },
    ],
    roles: [
      { oldRoleId: guildId, name: "@everyone", position: 0, managed: false },
      { oldRoleId: "500000000000000001", name: "normal", position: 1, managed: false },
      { oldRoleId: "500000000000000002", name: "managed", position: 2, managed: true },
      { oldRoleId: "500000000000000003", name: "bot", position: 3, managed: false },
      { oldRoleId: "500000000000000004", name: "administrator", position: 4, managed: false },
      { oldRoleId: "500000000000000005", name: "above-bot", position: 9, managed: false },
    ],
  };
}

test("registered developer who owns the Guild is allowed", () => {
  assert.equal(
    assertDeveloperGuildAccess({
      developerId,
      ownerId: developerId,
      allowedAdminIds: [],
      environment,
    }),
    true,
  );
});

test("non-developer cannot execute", () => {
  expectCode(
    () =>
      assertDeveloperGuildAccess({
        developerId: "999999999999999999",
        ownerId: "999999999999999999",
        allowedAdminIds: [],
        environment,
      }),
    "DEVELOPER_FORBIDDEN",
  );
});

test("Guild administrator alone cannot execute without developer registration", () => {
  expectCode(
    () =>
      assertDeveloperGuildAccess({
        developerId: "888888888888888888",
        ownerId: "777777777777777777",
        allowedAdminIds: ["888888888888888888"],
        environment,
      }),
    "DEVELOPER_FORBIDDEN",
  );
});

test("registered developer must still own or be explicitly allowed for the Guild", () => {
  expectCode(
    () =>
      assertDeveloperGuildAccess({
        developerId,
        ownerId: "777777777777777777",
        allowedAdminIds: [],
        environment,
      }),
    "GUILD_CONTROL_FORBIDDEN",
  );
});

test("invalid Guild ID is rejected", () => {
  assert.equal(isDiscordId("not-a-guild"), false);
  assert.equal(isDiscordId(guildId), true);
});

test("default plan is dry-run and channels-only", () => {
  const options = normalizeResetOptions({ reason: "安全な確認" });
  assert.equal(options.mode, "channels_only");
  assert.equal(options.dryRun, true);
  assert.equal(options.deleteChannels, true);
  assert.equal(options.deleteRoles, false);
  assert.equal(options.resetSettings, false);
});

test("role deletion requires explicit acknowledgement", () => {
  expectCode(
    () =>
      normalizeResetOptions({
        mode: "channels_and_roles",
        deleteRoles: false,
        reason: "安全な確認",
      }),
    "ROLE_DELETE_NOT_ACKNOWLEDGED",
  );
});

test("settings reset requires explicit acknowledgement", () => {
  expectCode(
    () =>
      normalizeResetOptions({
        mode: "settings_reset",
        resetSettings: false,
        reason: "安全な確認",
      }),
    "SETTINGS_RESET_NOT_ACKNOWLEDGED",
  );
});

test("expired Plan is rejected", () => {
  expectCode(
    () =>
      assertPlanUsable(
        activePlan({ expiresAt: new Date(Date.now() - 1).toISOString() }),
        { guildId, developerId },
      ),
    "PLAN_EXPIRED",
  );
});

test("Plan creator and executor must match", () => {
  expectCode(
    () => assertPlanUsable(activePlan(), { guildId, developerId: otherDeveloperId }),
    "PLAN_OWNER_MISMATCH",
  );
});

test("Plan cannot be reused for another Guild", () => {
  expectCode(
    () =>
      assertPlanUsable(activePlan(), {
        guildId: "666666666666666666",
        developerId,
      }),
    "PLAN_GUILD_MISMATCH",
  );
});

test("used Plan cannot be replayed", () => {
  expectCode(
    () =>
      assertPlanUsable(activePlan({ usedAt: new Date().toISOString() }), {
        guildId,
        developerId,
      }),
    "PLAN_ALREADY_USED",
  );
});

test("expired confirmation code is rejected", () => {
  expectCode(
    () =>
      assertConfirmationUsable(
        confirmation({ expiresAt: new Date(Date.now() - 1).toISOString() }),
        { planId: activePlan().id, guildId, developerId },
      ),
    "CODE_EXPIRED",
  );
});

test("confirmation code cannot be reused", () => {
  expectCode(
    () =>
      assertConfirmationUsable(
        confirmation({ usedAt: new Date().toISOString() }),
        { planId: activePlan().id, guildId, developerId },
      ),
    "CODE_ALREADY_USED",
  );
});

test("confirmation is bound to Plan, Guild, and developer", () => {
  expectCode(
    () =>
      assertConfirmationUsable(confirmation(), {
        planId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        guildId,
        developerId,
      }),
    "CODE_INVALID",
  );
});

test("confirmation code hash rejects mismatched code", () => {
  const secret = "test-secret-that-is-not-used-in-production";
  const codeHash = hashConfirmationCode({
    code: "12345678",
    planId: activePlan().id,
    guildId,
    developerId,
    secret,
  });
  assert.equal(
    verifyConfirmationCode({
      code: "87654321",
      codeHash,
      planId: activePlan().id,
      guildId,
      developerId,
      secret,
    }),
    false,
  );
});

test("confirmation code uses at least six cryptographically generated digits", () => {
  const code = generateConfirmationCode();
  assert.match(code, /^\d{8}$/);
});

test("target snapshot changes are rejected", () => {
  expectCode(() => assertSnapshotMatches("planned", "changed"), "SNAPSHOT_CHANGED");
  assert.equal(assertSnapshotMatches("same", "same"), true);
});

test("snapshot hashing is deterministic across object key order", () => {
  assert.equal(hashGuildSnapshot({ b: 2, a: 1 }), hashGuildSnapshot({ a: 1, b: 2 }));
});

test("channel and total operation limits are enforced", () => {
  const limits = {
    maxChannelDeletes: 1,
    maxRoleDeletes: 25,
    maxTotalOperations: 2,
  };
  const state = getLimitState(
    { channelDeleteCount: 2, roleDeleteCount: 0, totalOperationCount: 3 },
    limits,
  );
  assert.equal(state.exceeded, true);
  assert.equal(state.reasons.length, 2);
});

test("cooldown applies only after a real operation started", () => {
  const now = Date.now();
  assert.ok(
    getCooldownRemaining({
      lastStartedAt: new Date(now - 1_000),
      durationMilliseconds: 60_000,
      now,
    }) > 0,
  );
  assert.equal(
    getCooldownRemaining({
      lastStartedAt: new Date(now - 1_000),
      durationMilliseconds: 60_000,
      dryRun: true,
      now,
    }),
    0,
  );
  assert.equal(
    getCooldownRemaining({
      lastStartedAt: new Date(now - 1_000),
      durationMilliseconds: 60_000,
      operationStarted: false,
      now,
    }),
    0,
  );
});

test("global and Guild lock failures prevent concurrent execution", () => {
  expectCode(() => assertLockAvailable(false), "LOCKED");
  assert.equal(assertLockAvailable(true), true);
});

test("protected channel is never selected", () => {
  const result = selectResetTargets({
    snapshot: snapshot(),
    options: {
      deleteChannels: true,
      deleteRoles: false,
      keepChannelIds: [],
      keepRoleIds: [],
    },
    settings: {
      protectedChannelIds: ["400000000000000001"],
      protectedRoleIds: [],
      resetLogChannelId: "400000000000000002",
      backupChannelId: null,
    },
    botRoleId: "500000000000000003",
    botHighestRolePosition: 8,
    botAssignedRoleIds: [],
    administratorRoleIds: [],
  });
  assert.deepEqual(result.channels, []);
  assert.equal(result.protectedChannels.length, 2);
});

test("@everyone, Bot, Managed, Administrator, and above-Bot roles are protected", () => {
  const result = selectResetTargets({
    snapshot: snapshot(),
    options: {
      deleteChannels: false,
      deleteRoles: true,
      keepChannelIds: [],
      keepRoleIds: [],
    },
    settings: {
      protectedChannelIds: [],
      protectedRoleIds: [],
      resetLogChannelId: null,
      backupChannelId: null,
    },
    botRoleId: "500000000000000003",
    botHighestRolePosition: 8,
    botAssignedRoleIds: ["500000000000000003"],
    administratorRoleIds: ["500000000000000004"],
  });
  assert.deepEqual(result.roles.map((role) => role.name), ["normal"]);
  for (const protectedName of [
    "@everyone",
    "managed",
    "bot",
    "administrator",
    "above-bot",
  ]) {
    assert.ok(result.protectedRoles.some((role) => role.name === protectedName));
  }
});

test("protected target conflict is an immediate failure", () => {
  expectCode(
    () =>
      assertTargetsNotProtected(
        ["400000000000000001"],
        ["400000000000000001"],
        "チャンネル",
      ),
    "PROTECTED_TARGET",
  );
});

test("Dry Run produces only skipped audit items and no mutation call", () => {
  const items = buildDryRunItems(
    {
      deleteChannels: [{ id: "1", name: "general" }],
      deleteRoles: [{ id: "2", name: "role" }],
      settingsChanges: ["afkChannel"],
    },
    { createDefaultChannels: true },
  );
  assert.equal(items.length, 6);
  assert.ok(items.every((item) => item.status === "skipped" && item.errorCode === "DRY_RUN"));
});

test("backup failure prevents mutation from starting", async () => {
  let mutationStarted = false;
  await assert.rejects(
    requireBackupBeforeMutation(
      async () => {
        throw new Error("disk unavailable");
      },
      async () => {
        mutationStarted = true;
      },
    ),
  );
  assert.equal(mutationStarted, false);
});

test("backup document includes restoration IDs, dependency data, Plan, version, and executor", () => {
  const backup = buildBackupDocument({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    botVersion: "0.1.0",
    executionId: "execution",
    developerId,
    developerName: "developer",
    plan: {
      ...activePlan(),
      mode: "channels_only",
      dryRun: true,
      requestedOptions: {},
      targetSnapshotHash: "hash",
      targetSummary: {},
    },
    snapshot: {
      guild: { id: guildId },
      channels: [{ oldChannelId: "1", parentId: null, position: 0, permissionOverwrites: [] }],
      roles: [{ oldRoleId: "2", position: 0, permissions: "0" }],
      dependency: { botRoleId: "2" },
    },
  });
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.executor.id, developerId);
  assert.equal(backup.channels[0].oldChannelId, "1");
  assert.equal(backup.roles[0].oldRoleId, "2");
  assert.equal(backup.dependency.botRoleId, "2");
  assert.equal(backup.plan.targetSnapshotHash, "hash");
});

test("child channels are ordered before categories", () => {
  const ordered = orderChannelTargets([
    { id: "category", type: "GuildCategory", parentId: null, position: 0 },
    { id: "top", type: "GuildText", parentId: null, position: 1 },
    { id: "child", type: "GuildText", parentId: "category", position: 2 },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["child", "top", "category"]);
});

test("roles are ordered from lower to higher position", () => {
  const ordered = orderRoleTargets([
    { id: "high", position: 10 },
    { id: "low", position: 1 },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["low", "high"]);
});

test("partial deletion failures are included in result aggregation", () => {
  assert.deepEqual(
    summarizeExecutionItems([
      { status: "success" },
      { status: "failed" },
      { status: "skipped" },
    ]),
    { successCount: 1, failedCount: 1, skippedCount: 1 },
  );
});

test("audit item count matches every attempted operation", () => {
  const items = buildDryRunItems(
    {
      deleteChannels: [{ id: "1", name: "a" }, { id: "2", name: "b" }],
      deleteRoles: [],
      settingsChanges: ["verificationLevel"],
    },
    { createDefaultChannels: false },
  );
  assert.equal(items.length, 3);
  assert.deepEqual(summarizeExecutionItems(items), {
    successCount: 0,
    failedCount: 0,
    skippedCount: 3,
  });
});

test("lock release runs in finally after an unexpected failure", async () => {
  let released = false;
  await assert.rejects(
    runWithRelease(
      async () => {
        throw new Error("operation failed");
      },
      async () => {
        released = true;
      },
    ),
  );
  assert.equal(released, true);
});
