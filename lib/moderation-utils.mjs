export const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

export function normalizeModerationReason(value, maxLength = 300) {
  const reason = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (reason.length < 3) {
    throw new Error("理由は3文字以上で入力してください。");
  }
  return reason.slice(0, maxLength);
}

export function validateTimeoutMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MINUTES) {
    throw new Error(`タイムアウト時間は1〜${MAX_TIMEOUT_MINUTES}分で指定してください。`);
  }
  return value;
}

export function validateDiscordId(value) {
  return /^\d{17,20}$/.test(String(value ?? "").trim());
}

export function formatModerationActionResult(action, timeoutMinutes = null) {
  if (action === "ban") return "BANしました";
  if (action === "kick") return "Kickしました";
  if (action === "timeout") {
    return `${validateTimeoutMinutes(timeoutMinutes).toLocaleString("ja-JP")}分タイムアウトしました`;
  }
  if (action === "untimeout") return "タイムアウトを解除しました";
  throw new Error("未対応のモデレーション操作です。");
}

export function getModerationTargetError({
  actorId,
  botId,
  guildOwnerId,
  targetId,
  actorRolePosition,
  botRolePosition,
  targetRolePosition,
  targetIsAdministrator = false,
  actionAvailable = true,
}) {
  if (targetId === actorId) return "自分自身を対象にはできません。";
  if (targetId === botId) return "NuviloChan Bot自身を対象にはできません。";
  if (targetId === guildOwnerId) return "サーバー所有者を対象にはできません。";
  if (targetIsAdministrator && actorId !== guildOwnerId) {
    return "Administrator権限を持つメンバーは、サーバー所有者だけが対象にできます。";
  }
  if (
    actorId !== guildOwnerId &&
    Number(targetRolePosition) >= Number(actorRolePosition)
  ) {
    return "自分と同じか上位のロールを持つメンバーは対象にできません。";
  }
  if (Number(targetRolePosition) >= Number(botRolePosition)) {
    return "Botと同じか上位のロールを持つメンバーは対象にできません。";
  }
  if (!actionAvailable) {
    return "Discordのロール階層または権限により、このメンバーを対象にできません。";
  }
  return null;
}
