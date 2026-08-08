import test from "node:test";
import assert from "node:assert/strict";
import {
  canManageSpamAction,
  createSpamActionCustomId,
  createSpamTracker,
  getAutomaticSpamProtectionBlockReason,
  parseSpamActionCustomId,
} from "../lib/spam-protection.mjs";

test("spam is detected on the eighth message inside five seconds", () => {
  const tracker = createSpamTracker({
    messageLimit: 8,
    windowMs: 5_000,
    detectionCooldownMs: 60_000,
  });
  for (let index = 0; index < 7; index += 1) {
    assert.equal(tracker.record("guild:user", index * 500).detected, false);
  }
  const result = tracker.record("guild:user", 3_500);
  assert.equal(result.detected, true);
  assert.equal(result.count, 8);
});

test("messages outside the rolling window do not trigger detection", () => {
  const tracker = createSpamTracker({
    messageLimit: 8,
    windowMs: 5_000,
    detectionCooldownMs: 60_000,
  });
  for (let index = 0; index < 7; index += 1) {
    tracker.record("guild:user", index * 500);
  }
  const result = tracker.record("guild:user", 8_501);
  assert.equal(result.detected, false);
  assert.equal(result.count, 1);
});

test("a detection cooldown prevents repeated automatic punishments", () => {
  const tracker = createSpamTracker({
    messageLimit: 2,
    windowMs: 1_000,
    detectionCooldownMs: 10_000,
  });
  tracker.record("guild:user", 0);
  assert.equal(tracker.record("guild:user", 100).detected, true);
  const cooled = tracker.record("guild:user", 200);
  assert.equal(cooled.detected, false);
  assert.equal(cooled.coolingDown, true);
  assert.equal(tracker.record("guild:user", 10_101).coolingDown, false);
});

test("prune removes inactive windows and expired cooldowns", () => {
  const tracker = createSpamTracker({
    messageLimit: 2,
    windowMs: 1_000,
    detectionCooldownMs: 10_000,
  });
  tracker.record("window", 0);
  tracker.record("cooldown", 0);
  tracker.record("cooldown", 1);
  tracker.prune(10_002);
  assert.equal(tracker.trackedWindowCount, 0);
  assert.equal(tracker.cooldownCount, 0);
});

test("automatic timeout protects bots, owners, and moderators", () => {
  assert.equal(
    getAutomaticSpamProtectionBlockReason({
      isBot: true,
      isOwner: false,
      hasModerationPermission: false,
    }),
    "Botアカウント",
  );
  assert.equal(
    getAutomaticSpamProtectionBlockReason({
      isBot: false,
      isOwner: true,
      hasModerationPermission: false,
    }),
    "サーバー所有者",
  );
  assert.equal(
    getAutomaticSpamProtectionBlockReason({
      isBot: false,
      isOwner: false,
      hasModerationPermission: true,
    }),
    "管理・モデレーション権限を持つメンバー",
  );
  assert.equal(
    getAutomaticSpamProtectionBlockReason({
      isBot: false,
      isOwner: false,
      hasModerationPermission: false,
    }),
    null,
  );
});

test("owners, administrators, and appropriately-permitted moderators can use spam actions", () => {
  assert.equal(
    canManageSpamAction({
      isOwner: true,
      isAdministrator: false,
      hasRequiredPermission: false,
    }),
    true,
  );
  assert.equal(
    canManageSpamAction({
      isOwner: false,
      isAdministrator: true,
      hasRequiredPermission: false,
    }),
    true,
  );
  assert.equal(
    canManageSpamAction({
      isOwner: false,
      isAdministrator: false,
      hasRequiredPermission: true,
    }),
    true,
  );
  assert.equal(
    canManageSpamAction({
      isOwner: false,
      isAdministrator: false,
      hasRequiredPermission: false,
    }),
    false,
  );
});

test("spam action IDs safely carry the original detection log reference", () => {
  const detectionId = "23d21d6c-7606-42e7-9c40-77ddef1466a1";
  const customId = createSpamActionCustomId({
    stage: "execute",
    action: "kick",
    detectionId,
    alertChannelId: "1522919552999227418",
    alertMessageId: "1523654405839392838",
  });
  assert.ok(customId.length <= 100);
  assert.deepEqual(parseSpamActionCustomId(customId), {
    stage: "execute",
    action: "kick",
    detectionId,
    alertChannelId: "1522919552999227418",
    alertMessageId: "1523654405839392838",
  });
});

test("malformed or partial spam alert references are rejected", () => {
  assert.equal(
    parseSpamActionCustomId(
      "nvspam:execute:ban:23d21d6c-7606-42e7-9c40-77ddef1466a1:1522919552999227418",
    ),
    null,
  );
  assert.throws(
    () =>
      createSpamActionCustomId({
        stage: "execute",
        action: "ban",
        detectionId: "23d21d6c-7606-42e7-9c40-77ddef1466a1",
        alertChannelId: "1522919552999227418",
      }),
    /provided together/,
  );
});
