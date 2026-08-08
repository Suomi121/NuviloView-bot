import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TIMEOUT_MINUTES,
  formatModerationActionResult,
  getModerationTargetError,
  normalizeModerationReason,
  validateDiscordId,
  validateTimeoutMinutes,
} from "../lib/moderation-utils.mjs";

const validTarget = {
  actorId: "100000000000000001",
  botId: "100000000000000002",
  guildOwnerId: "100000000000000003",
  targetId: "100000000000000004",
  actorRolePosition: 20,
  botRolePosition: 30,
  targetRolePosition: 10,
  targetIsAdministrator: false,
  actionAvailable: true,
};

test("moderation rejects self, Bot, and Guild owner targets", () => {
  assert.match(
    getModerationTargetError({ ...validTarget, targetId: validTarget.actorId }),
    /自分自身/,
  );
  assert.match(
    getModerationTargetError({ ...validTarget, targetId: validTarget.botId }),
    /Bot自身/,
  );
  assert.match(
    getModerationTargetError({ ...validTarget, targetId: validTarget.guildOwnerId }),
    /所有者/,
  );
});

test("moderation enforces actor and Bot role hierarchy", () => {
  assert.match(
    getModerationTargetError({ ...validTarget, targetRolePosition: 20 }),
    /上位のロール/,
  );
  assert.match(
    getModerationTargetError({
      ...validTarget,
      actorId: validTarget.guildOwnerId,
      targetRolePosition: 30,
    }),
    /Botと同じか上位/,
  );
});

test("only Guild owner can target an administrator", () => {
  assert.match(
    getModerationTargetError({ ...validTarget, targetIsAdministrator: true }),
    /サーバー所有者だけ/,
  );
  assert.equal(
    getModerationTargetError({
      ...validTarget,
      actorId: validTarget.guildOwnerId,
      targetIsAdministrator: true,
    }),
    null,
  );
});

test("moderation requires Discord to report the action as available", () => {
  assert.match(
    getModerationTargetError({ ...validTarget, actionAvailable: false }),
    /ロール階層または権限/,
  );
});

test("moderation reasons are normalized and bounded", () => {
  assert.equal(normalizeModerationReason("  spam\nposting  "), "spam posting");
  assert.throws(() => normalizeModerationReason("no"), /3文字以上/);
  assert.equal(normalizeModerationReason("x".repeat(500)).length, 300);
});

test("timeout and Discord ID validation are bounded", () => {
  assert.equal(validateTimeoutMinutes(1), 1);
  assert.equal(validateTimeoutMinutes(MAX_TIMEOUT_MINUTES), MAX_TIMEOUT_MINUTES);
  assert.throws(() => validateTimeoutMinutes(0), /タイムアウト時間/);
  assert.throws(() => validateTimeoutMinutes(MAX_TIMEOUT_MINUTES + 1), /タイムアウト時間/);
  assert.equal(validateDiscordId("12345678901234567"), true);
  assert.equal(validateDiscordId("123"), false);
});

test("untimeout success text does not require timeout minutes", () => {
  assert.equal(
    formatModerationActionResult("untimeout", null),
    "タイムアウトを解除しました",
  );
  assert.equal(
    formatModerationActionResult("timeout", 5),
    "5分タイムアウトしました",
  );
});
