import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { buildOnboardingTutorial, createGuildOnboarding, selectOnboardingChannel } from "../lib/guild-onboarding.mjs";

const botSource = readFileSync(new URL("../discord-bot.mjs", import.meta.url), "utf8");
const url = botSource.match(/const dashboardUrl = "([^"]+)"/)[1];
function fixture() {
  const sends = [], logs = [];
  const guild = { id: "guild", joinedTimestamp: 200, roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" } }, channels: { cache: new Map() },
    fetchOwner: async () => ({ send: async (payload) => sends.push({ type: "dm", payload }) }) };
  function channel(id, name, { missing = [], publicView = true, position = 0, type = ChannelType.GuildText } = {}) {
    const result = { id, name, guild, type, rawPosition: position,
      permissionsFor: (subject) => ({ has: (bits) => subject.id === "everyone" ? publicView :
        (Array.isArray(bits) ? bits : [bits]).every((bit) => !missing.includes(bit)) }),
      send: async (payload) => sends.push({ id, payload }) };
    guild.channels.cache.set(id, result);
    return result;
  }
  return { guild, sends, logs, channel, onboard: createGuildOnboarding({ dashboardUrl: url, startedAt: 100, logger: (entry) => logs.push(entry) }) };
}

test("system channel exactly once, including concurrent duplicate delivery", async () => {
  const f = fixture(); f.guild.systemChannel = f.channel("sys", "system"); f.channel("welcome", "welcome");
  await Promise.all(Array.from({ length: 10 }, () => f.onboard(f.guild)));
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].id, "sys");
  assert.equal(f.logs[0].type, "system-channel");
});
for (const permission of [P.ViewChannel, P.SendMessages, P.EmbedLinks]) {
  test(`missing effective permission ${permission} skips system channel`, async () => {
    const f = fixture(); f.guild.systemChannel = f.channel("sys", "system", { missing: [permission] });
    f.channel("join", "member-log"); await f.onboard(f.guild);
    assert.equal(f.sends[0].id, "join");
  });
}
test("explicit configured join channel ranks ahead of name fallback", () => {
  const f = fixture(); f.channel("configured", "custom"); f.channel("welcome", "welcome");
  assert.equal(selectOnboardingChannel(f.guild, f.guild.members.me, "configured").type, "configured-join-log");
  assert.equal(selectOnboardingChannel(f.guild, f.guild.members.me, "missing").channel.id, "welcome");
});
test("join names outrank bot logs and general, position breaks ties", async () => {
  const f = fixture(); f.channel("general", "general"); f.channel("bot", "bot-log");
  f.channel("late", "welcome", { position: 10 }); f.channel("early", "入退室", { position: 1 });
  await f.onboard(f.guild); assert.equal(f.sends[0].id, "early");
});
for (const name of ["welcome", "join", "member-logs", "入室", "参加", "案内", "botログ", "logs"]) {
  test(`safe named fallback: ${name}`, async () => {
    const f = fixture(); f.channel("named", name); await f.onboard(f.guild);
    assert.equal(f.logs[0].type, "named-fallback");
  });
}
test("general is the last guild fallback", async () => {
  const f = fixture(); f.channel("arbitrary", "photos"); f.channel("general", "雑談");
  await f.onboard(f.guild); assert.equal(f.sends[0].id, "general");
  assert.equal(f.logs[0].type, "general-fallback");
});
test("private named staff, random text, voice and thread are never guessed", async () => {
  const f = fixture(); f.channel("private", "member-log", { publicView: false });
  f.channel("random", "photos"); f.channel("voice", "general", { type: ChannelType.GuildVoice });
  f.channel("thread", "welcome", { type: ChannelType.PublicThread });
  await f.onboard(f.guild); assert.equal(f.sends[0].type, "dm");
});
test("owner DM denied exits safely and logs only safe metadata", async () => {
  const f = fixture(); f.guild.fetchOwner = async () => ({ send: async () => { throw Object.assign(new Error("sensitive error text"), { code: 50007 }); } });
  await f.onboard(f.guild); assert.equal(f.logs[0].code, 50007);
  assert.equal(JSON.stringify(f.logs).includes("sensitive"), false);
});
test("owner fetch and member fetch failure are isolated", async () => {
  for (const memberFailure of [false, true]) {
    const f = fixture();
    if (memberFailure) f.guild.members = { fetchMe: async () => { throw new Error("fetch"); } };
    else f.guild.fetchOwner = async () => { throw new Error("fetch"); };
    await f.onboard(f.guild); assert.equal(f.sends.length, 0); assert.equal(f.logs[0].result, "failure");
  }
});
test("ambiguous send failure never retries a second channel or DM", async () => {
  const f = fixture(); f.guild.systemChannel = f.channel("sys", "system"); f.channel("general", "general");
  let attempts = 0; f.guild.systemChannel.send = async () => { attempts++; throw new Error("timeout"); };
  await f.onboard(f.guild); await f.onboard(f.guild);
  assert.equal(attempts, 1); assert.equal(f.sends.length, 0);
});
test("restart refuses preexisting guild even with a fresh in-memory state", async () => {
  const f = fixture(); f.guild.joinedTimestamp = 99;
  await f.onboard(f.guild);
  await createGuildOnboarding({ dashboardUrl: url, startedAt: 300 })(f.guild);
  assert.equal(f.sends.length, 0);
});
test("reconnect repeated event never sends twice; unknown join date is skipped", async () => {
  const f = fixture(); await f.onboard(f.guild); await f.onboard(f.guild);
  assert.equal(f.sends.length, 1);
  f.guild.id = "unknown"; f.guild.joinedTimestamp = null; await f.onboard(f.guild);
  assert.equal(f.sends.length, 1);
});
test("payload is non-mentioning, concise and uses only actual commands and canonical URL", () => {
  const payload = buildOnboardingTutorial(url);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  for (const match of JSON.stringify(payload.embeds).matchAll(/\/([a-z]+)/g)) {
    assert.ok(botSource.includes(`.setName("${match[1]}")`));
  }
  assert.equal(payload.components[0].components[0].url, new URL("dashboard", url).href);
  const body = JSON.stringify(payload.embeds);
  assert.match(body, /準備中/); assert.match(body, /Googleログインだけでは/);
  assert.ok(body.length < 2500); assert.doesNotMatch(body, /Supabase|Turso|Projection|Worker/);
});
test("integration calls onboarding only in guildCreate, after blocked-guild guard, before cloud gate", () => {
  assert.equal((botSource.match(/void onboardGuild\(guild\)/g) ?? []).length, 1);
  const create = botSource.slice(botSource.indexOf('client.on("guildCreate"'), botSource.indexOf('client.on("guildDelete"'));
  assert.ok(create.indexOf("leaveBlockedGuild") < create.indexOf("void onboardGuild"));
  assert.ok(create.indexOf("void onboardGuild") < create.indexOf("cloudDatabase.isAvailable"));
});
