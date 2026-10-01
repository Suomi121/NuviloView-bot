import { ChannelType, PermissionFlagsBits } from "discord.js";

const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
const joinName = /入室|入退室|参加|ようこそ|案内|(?:^|[-_\s])(?:welcome|join|member-logs?)(?:$|[-_\s])/iu;
const logName = /ログ|(?:^|[-_\s])(?:logs?|bot(?:-logs?)?)(?:$|[-_\s])/iu;
const generalName = /^(?:general|一般|雑談)$/iu;

export function selectOnboardingChannel(guild, member, configuredJoinChannelId = null) {
  const channels = [...guild.channels.cache.values()];
  const usable = (channel) => channel?.guild?.id === guild.id &&
    [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) &&
    channel.permissionsFor(member)?.has(required);
  if (usable(guild.systemChannel)) return { channel: guild.systemChannel, type: "system-channel" };
  const configured = guild.channels.cache.get(configuredJoinChannelId);
  if (usable(configured)) return { channel: configured, type: "configured-join-log" };
  // Names alone must never select a private staff channel.
  const publicCandidates = channels.filter((channel) => usable(channel) &&
    channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))
    .sort((a, b) => (a.rawPosition - b.rawPosition) || a.id.localeCompare(b.id));
  for (const pattern of [joinName, logName, generalName]) {
    const channel = publicCandidates.find((candidate) => pattern.test(candidate.name));
    if (channel) return { channel, type: pattern === generalName ? "general-fallback" : "named-fallback" };
  }
  return null;
}

export function buildOnboardingTutorial(dashboardUrl) {
  return {
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    embeds: [{
      title: "📊 NuviloViewへようこそ！",
      color: 0x7877ff,
      description: "導入ありがとうございます。NuviloViewは、このサーバーの活動状況を収集・分析し、Dashboardで確認できるようにします。",
      fields: [
        { name: "① Botの権限を確認", value: "`/permissions` でデータ取得に必要な権限を確認してください。" },
        { name: "② Dashboardを開く", value: "下のボタン、または `/dashboard` から開き、Discordでログインしてください。" },
        { name: "③ このサーバーを選択", value: "連携したDiscordアカウントが管理できるサーバーを選択します。Googleログインだけではサーバーの閲覧権限は付与されません。" },
        { name: "④ データが集まるまで待つ", value: "導入直後は「準備中」と表示される項目があります。データの蓄積・処理に伴い、順次分析結果が表示されます。" },
        { name: "⑤ Privacy / ⑥ Help", value: "扱うデータは `/privacy`、使い方は `/help` で確認できます。" },
      ],
      footer: { text: "NuviloView • Server Analytics" },
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Dashboardを開く", url: new URL("dashboard", dashboardUrl).href }] }],
  };
}

export function createGuildOnboarding({ dashboardUrl, startedAt = Date.now(), logger = (entry) => console.info("[Onboarding]", entry) }) {
  const attempted = new Set();
  const payload = buildOnboardingTutorial(dashboardUrl);
  const log = (entry) => { try { logger(entry); } catch { /* Diagnostics must not interrupt the Bot. */ } };
  return async function onboard(guild) {
    // Fail closed for startup/reconnect deliveries of already joined guilds.
    if (!Number.isFinite(guild.joinedTimestamp) || guild.joinedTimestamp < startedAt || attempted.has(guild.id)) return;
    attempted.add(guild.id); // Claim before any await (concurrent guildCreate included).
    let type = "owner-dm";
    let channelId = null;
    try {
      const member = guild.members.me ?? await guild.members.fetchMe();
      const target = selectOnboardingChannel(guild, member);
      if (target) {
        type = target.type;
        channelId = target.channel.id;
        await target.channel.send(payload);
      } else {
        const owner = await guild.fetchOwner();
        await owner.send(payload);
      }
      log({ guildId: guild.id, channelId, type, result: "success" });
    } catch (error) {
      // Never try another destination after a send: timeout may mean it was delivered.
      log({ guildId: guild.id, channelId, type, result: "failure", reason: "delivery-unavailable",
        code: Number.isInteger(error?.code) ? error.code : null });
    }
  };
}
