import {
  ActivityType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL || !process.env.DISCORD_BOT_TOKEN) {
  throw new Error(
    "DATABASE_URL and DISCORD_BOT_TOKEN must be set before starting the bot.",
  );
}

const sql = neon(process.env.DATABASE_URL);
const messageRetentionDays = Number.isInteger(
  Number(process.env.MESSAGE_RETENTION_DAYS),
)
  ? Math.min(Math.max(Number(process.env.MESSAGE_RETENTION_DAYS), 7), 365)
  : 90;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const dashboardUrl = "https://nuviloview-oem.vercel.app/";
const applicationId = process.env.DISCORD_CLIENT_ID;
const developerGuildId = process.env.DISCORD_DEV_GUILD_ID;
const commandSyncCooldownMs = 60 * 1000;
const commandSyncAttempts = new Map();
const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("NuviloChan BotとNuviloViewの使い方を表示します")
  .toJSON();
const commandUpdateCommand = new SlashCommandBuilder()
  .setName("cmup")
  .setDescription("開発用サーバーのコマンド定義を即時更新します")
  .toJSON();

function getRestClient() {
  return new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
}

async function registerCommands() {
  if (!applicationId)
    throw new Error(
      "DISCORD_CLIENT_ID must be set before registering slash commands.",
    );
  const rest = getRestClient();
  await rest.put(Routes.applicationCommands(applicationId), {
    body: [helpCommand],
  });
  if (developerGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(applicationId, developerGuildId),
      { body: [commandUpdateCommand] },
    );
    console.log(`Developer commands synced to guild ${developerGuildId}`);
  }
}

async function isApplicationOwner(userId) {
  const application = await client.application.fetch();
  const ownerId = application.owner?.id ?? application.owner?.ownerId;
  return ownerId === userId;
}

async function updateMemberCount(guild) {
  await sql`
    INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "date")
    VALUES (${guild.id}, ${guild.memberCount}, 0, CURRENT_DATE)
    ON CONFLICT ("guildId", "date")
    DO UPDATE SET "memberCount" = EXCLUDED."memberCount", "updatedAt" = now()
  `;
}

async function recordActivity({
  guildId,
  type,
  actorName,
  channelName = null,
}) {
  await sql`
    INSERT INTO "recent_activity" ("guildId", "type", "actorName", "channelName")
    VALUES (${guildId}, ${type}, ${actorName}, ${channelName})
  `;
}

async function recordActiveMember({ guildId, userId }) {
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
  if (!message.guild || message.author.bot || !message.content.trim()) return;
  const channelName =
    "name" in message.channel ? message.channel.name : "不明なチャンネル";
  await sql`
    INSERT INTO "discord_message" ("id", "guildId", "channelName", "authorId", "authorName", "content", "createdAt", "updatedAt")
    VALUES (${message.id}, ${message.guild.id}, ${channelName}, ${message.author.id}, ${message.member?.displayName ?? message.author.username}, ${message.content}, ${message.createdAt}, now())
    ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content", "updatedAt" = now()
  `;
}

async function purgeExpiredMessages() {
  await sql`DELETE FROM "discord_message" WHERE "createdAt" < now() - (${messageRetentionDays} * interval '1 day')`;
}

const historyImportDelayMs = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateHistoryImportJob(id, fields) {
  await sql`
    UPDATE "history_import_job"
    SET "processedMessages" = ${fields.processedMessages}, "failedChannels" = ${fields.failedChannels}
    WHERE "id" = ${id}
  `;
}

async function claimHistoryImportJob() {
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
async function processHistoryImportJob(job) {
  let processedMessages = 0;
  let failedChannels = 0;
  try {
    const guild =
      client.guilds.cache.get(job.guildId) ??
      (await client.guilds.fetch(job.guildId));
    if (!guild) throw new Error("Bot is not available in this server.");
    const cutoff = new Date(Date.now() - job.days * 24 * 60 * 60 * 1000);
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
          await updateHistoryImportJob(job.id, {
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
        await updateHistoryImportJob(job.id, {
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

async function pollHistoryImportJobs() {
  const job = await claimHistoryImportJob();
  if (job) await processHistoryImportJob(job);
}

function hasHumanVoiceActivity(guild) {
  return [...guild.voiceStates.cache.values()].some(
    (state) => state.channelId && state.member?.user.bot !== true,
  );
}

// A server session advances only once while at least one human is connected to
// any voice channel. Moving channels or adding members does not split it.
async function syncServerVoiceSession(guild) {
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
  client.user.setActivity("NuviloView", { type: ActivityType.Playing });
  console.log(`NuviloView:OEM bot logged in as ${client.user.tag}`);
  try {
    await registerCommands();
    await Promise.all(client.guilds.cache.map(updateMemberCount));
    await Promise.allSettled(
      client.guilds.cache.map(restoreTodayActiveMembers),
    );
    await Promise.allSettled(client.guilds.cache.map(syncServerVoiceSession));
    await purgeExpiredMessages();
    void pollHistoryImportJobs();
  } catch (error) {
    console.error("Initial member sync failed:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "cmup") {
    if (
      !developerGuildId ||
      interaction.guildId !== developerGuildId ||
      !(await isApplicationOwner(interaction.user.id))
    ) {
      await interaction.reply({
        content: "このコマンドは開発用サーバーのBot所有者のみ実行できます。",
        ephemeral: true,
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
        ephemeral: true,
      });
      return;
    }
    commandSyncAttempts.set(interaction.user.id, Date.now());
    try {
      await getRestClient().put(
        Routes.applicationGuildCommands(applicationId, developerGuildId),
        { body: [commandUpdateCommand] },
      );
      await interaction.reply({
        content: "✅ 開発用サーバーのコマンドを即時更新しました。",
        ephemeral: true,
      });
    } catch (error) {
      console.error("Developer command sync failed:", error);
      await interaction.reply({
        content: "コマンド更新に失敗しました。Botログを確認してください。",
        ephemeral: true,
      });
    }
    return;
  }
  if (interaction.commandName !== "help") return;
  const embed = new EmbedBuilder()
    .setColor(0x7877ff)
    .setTitle("NuviloChan Bot — Help")
    .setDescription(
      "NuviloChan Botは、サーバーの活動データをNuviloViewへ記録する分析Botです。",
    )
    .addFields(
      {
        name: "現在の状態",
        value: "🟢 オンライン・データ収集中",
        inline: true,
      },
      {
        name: "記録する内容",
        value: "メンバー数、メッセージ、リアクション、VC通話時間",
        inline: true,
      },
      { name: "ダッシュボード", value: dashboardUrl },
    )
    .setFooter({ text: "分析の閲覧にはサーバー管理権限が必要です。" });

  await interaction.reply({ embeds: [embed] });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

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

client.on("messageDelete", async (message) => {
  try {
    await sql`DELETE FROM "discord_message" WHERE "id" = ${message.id}`;
  } catch (error) {
    console.error("Failed to remove a deleted Discord message:", error);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot || !reaction.message.guild) return;
  try {
    const guild = reaction.message.guild;
    await sql`
      INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "reactionCount", "date")
      VALUES (${guild.id}, ${guild.memberCount}, 0, 1, CURRENT_DATE)
      ON CONFLICT ("guildId", "date")
      DO UPDATE SET
        "reactionCount" = "daily_stats"."reactionCount" + 1,
        "memberCount" = EXCLUDED."memberCount",
        "updatedAt" = now()
    `;
  } catch (error) {
    console.error("Failed to count a Discord reaction:", error);
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;
  void syncServerVoiceSession(newState.guild).catch((error) =>
    console.error("Failed to sync server voice activity:", error),
  );
});

client.on(
  "guildMemberAdd",
  (member) =>
    void Promise.all([
      updateMemberCount(member.guild),
      recordActivity({
        guildId: member.guild.id,
        type: "member_joined",
        actorName: member.displayName,
      }),
    ]),
);
client.on(
  "guildMemberRemove",
  (member) =>
    void Promise.all([
      updateMemberCount(member.guild),
      recordActivity({
        guildId: member.guild.id,
        type: "member_left",
        actorName: member.user.username,
      }),
      syncServerVoiceSession(member.guild),
    ]),
);
client.on("error", (error) => console.error("Discord client error:", error));

setInterval(
  () => {
    void Promise.all(client.guilds.cache.map(updateMemberCount));
  },
  15 * 60 * 1000,
);

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
}, 30 * 1000);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Disconnecting NuviloChan Bot...`);
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await client.login(process.env.DISCORD_BOT_TOKEN);
