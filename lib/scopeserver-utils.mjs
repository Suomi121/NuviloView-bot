export function plainComponentText(value, maxLength = 100) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "名称なし").slice(0, maxLength);
}

export function escapeScopeText(value, maxLength = 360) {
  const normalized = String(value ?? "")
    .replace(/\\/g, "＼")
    .replace(/`/g, "ˋ")
    .replace(/@/g, "＠")
    .replace(/([*_~|>#[\]()])/g, "\\$1")
    .replace(/\r/g, "")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatScopeMessage(message, index) {
  const authorName = escapeScopeText(
    message.member?.displayName || message.author?.globalName || message.author?.username || "取得不能",
    80,
  );
  const authorId = message.author?.id ?? "取得不能";
  const tags = [];
  if (message.system) tags.push("SYSTEM");
  if (message.webhookId) tags.push("WEBHOOK");
  else if (message.author?.bot) tags.push("BOT");
  else tags.push("USER");

  const attachmentCount = message.attachments?.size ?? 0;
  const embedCount = message.embeds?.length ?? 0;
  const stickerCount = message.stickers?.size ?? 0;
  const nonTextParts = [];
  if (attachmentCount > 0) nonTextParts.push(`添付 ${attachmentCount}件`);
  if (embedCount > 0) nonTextParts.push(`Embed ${embedCount}件`);
  if (stickerCount > 0) nonTextParts.push(`スタンプ ${stickerCount}件`);

  const body = message.content?.trim()
    ? escapeScopeText(message.content, 360)
    : `（本文なし${nonTextParts.length ? `・${nonTextParts.join("・")}` : ""}）`;
  const timestamp = Math.floor(message.createdTimestamp / 1000);
  const messageUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  return (
    `**${index}. ${authorName}** \`${tags.join(" · ")}\`\n` +
    `<t:${timestamp}:f> · 投稿者ID \`${authorId}\`\n` +
    `${body}\n` +
    `${nonTextParts.length && message.content?.trim() ? `-# ${nonTextParts.join(" · ")}\n` : ""}` +
    `-# Message ID \`${message.id}\` · [Discordで開く](${messageUrl})`
  );
}
