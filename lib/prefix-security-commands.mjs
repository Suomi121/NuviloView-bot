export const securityCommandPrefix = "r?";

export const securityCommandDefinitions = Object.freeze([
  {
    name: "help",
    usage: "r?help [command]",
    description: "セキュリティコマンドの一覧または詳しい使い方を表示します。",
  },
  {
    name: "ban",
    usage: "r?ban @user <reason> --confirm",
    description: "指定したメンバーを確認付きでBANします。",
  },
  {
    name: "unban",
    usage: "r?unban <user_id> <reason>",
    description: "Discord IDを指定してBANを解除します。",
  },
  {
    name: "kick",
    usage: "r?kick @user <reason> --confirm",
    description: "指定したメンバーを確認付きでKickします。",
  },
  {
    name: "timeout",
    usage: "r?timeout @user <minutes> <reason>",
    description: "指定したメンバーを1〜40320分タイムアウトします。",
  },
  {
    name: "untimeout",
    usage: "r?untimeout @user <reason>",
    description: "指定したメンバーのタイムアウトを解除します。",
  },
  {
    name: "banlist",
    usage: "r?banlist [page]",
    description: "このサーバーのBANユーザー一覧を表示します。",
  },
  {
    name: "clear",
    usage: "r?clear <amount> <reason> --confirm",
    description: "ピン留めと14日超の投稿を保護して1〜100件削除します。",
  },
  {
    name: "ping",
    usage: "r?ping",
    description: "Botの応答速度とDiscord・NeonDBの接続状態を表示します。",
  },
  {
    name: "perm_check",
    usage: "r?perm_check",
    description:
      "実行者とBotの権限を照合し、利用できるセキュリティ機能を確認します。",
  },
]);

const definitionsByName = new Map(
  securityCommandDefinitions.map((definition) => [definition.name, definition]),
);

export const securityPermissionCheckDefinitions = Object.freeze([
  {
    key: "ban",
    label: "BAN・BAN解除・BAN一覧",
    commands: "r?ban / r?unban / r?banlist",
    actorPermission: "BanMembers",
    botPermission: "BanMembers",
  },
  {
    key: "kick",
    label: "Kick",
    commands: "r?kick",
    actorPermission: "KickMembers",
    botPermission: "KickMembers",
  },
  {
    key: "timeout",
    label: "Timeout・Timeout解除",
    commands: "r?timeout / r?untimeout",
    actorPermission: "ModerateMembers",
    botPermission: "ModerateMembers",
  },
  {
    key: "clear",
    label: "メッセージ削除",
    commands: "r?clear",
    actorPermission: "ManageMessages",
    botPermission: "ManageMessages",
  },
]);

export function evaluateSecurityPermissionChecks({
  actorIsOwner = false,
  actorIsAdministrator = false,
  actorPermissions = [],
  botPermissions = [],
} = {}) {
  const actorPermissionSet = new Set(actorPermissions);
  const botPermissionSet = new Set(botPermissions);
  const actorIsPrivileged = actorIsOwner || actorIsAdministrator;
  return securityPermissionCheckDefinitions.map((definition) => {
    const actorAllowed =
      actorIsPrivileged ||
      actorPermissionSet.has(definition.actorPermission);
    const botAllowed = botPermissionSet.has(definition.botPermission);
    return {
      ...definition,
      actorAllowed,
      botAllowed,
      available: actorAllowed && botAllowed,
    };
  });
}

export function getSecurityCommandDefinition(name) {
  return definitionsByName.get(String(name ?? "").toLowerCase()) ?? null;
}

export function parseSecurityCommand(content) {
  const trimmed = String(content ?? "").trim();
  if (!trimmed.toLowerCase().startsWith(securityCommandPrefix)) return null;

  const commandText = trimmed.slice(securityCommandPrefix.length).trim();
  if (!commandText) {
    return {
      name: "help",
      args: [],
      argumentText: "",
      definition: definitionsByName.get("help"),
    };
  }

  const commandMatch = commandText.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const rawName = commandMatch?.[1] ?? "";
  const argumentText = commandMatch?.[2]?.trim() ?? "";
  const args = argumentText ? argumentText.split(/\s+/) : [];
  const name = rawName.toLowerCase();
  return {
    name,
    args,
    argumentText,
    definition: definitionsByName.get(name) ?? null,
  };
}

export function parseDiscordTargetId(value) {
  const token = String(value ?? "").trim();
  const mention = token.match(/^<@!?(\d{17,20})>$/);
  if (mention) return mention[1];
  return /^\d{17,20}$/.test(token) ? token : null;
}

export function extractConfirmation(args) {
  const normalized = Array.isArray(args) ? args : [];
  return {
    confirmed: normalized.some((argument) => argument.toLowerCase() === "--confirm"),
    args: normalized.filter((argument) => argument.toLowerCase() !== "--confirm"),
  };
}
