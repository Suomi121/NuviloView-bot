import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createMessageHistoryImportWorker,
  messageBatchRecords,
} from "../lib/message-history-import-worker.mjs";

function collection(messages) {
  return {
    size: messages.length,
    values: () => messages.values(),
    last: () => messages.at(-1),
  };
}

function discordMessage(id, content = "hello") {
  return {
    id,
    content,
    createdAt: new Date("2026-08-21T12:00:00Z"),
    author: { id: `author-${id}`, username: "Member", bot: false },
    member: { displayName: "Member" },
  };
}

function createFakeRepository({
  channels,
  control = () => ({ status: "running", cancelRequested: false, pauseRequested: false, skipRequested: false }),
  staleJobs = [],
}) {
  const state = { events: [], saved: [], settled: [], channels: [...channels], completed: false, failed: false };
  return {
    state,
    async recoverStale() { return staleJobs; },
    async claimNext() { return { id: 7, guildId: "123456789012345678", days: 0, version: 3 }; },
    async audit(event) { state.events.push(event); },
    async heartbeat() {},
    async control(jobId, channelId) { return control(jobId, channelId, state); },
    async prepareChannels() {},
    async nextChannel() { return state.channels.shift() ?? null; },
    async saveBatch(batch) {
      state.saved.push(batch);
      return { fetchedMessages: batch.fetchedCount, insertedMessages: batch.records.length, duplicateMessages: 0 };
    },
    async setRetry() {},
    async settleChannel(jobId, channelId, status, safe) { state.settled.push({ jobId, channelId, status, safe }); },
    async pause() { state.paused = true; },
    async cancel() { state.cancelled = true; },
    async complete() { state.completed = true; return { fetchedMessages: state.saved.reduce((sum, item) => sum + item.fetchedCount, 0), insertedMessages: state.saved.reduce((sum, item) => sum + item.records.length, 0), duplicateMessages: 0, failedChannels: state.settled.filter((item) => item.status === "failed").length }; },
    async fail() { state.failed = true; },
  };
}

function createDiscordClient(fetchByChannel) {
  const channelMap = new Map(Object.entries(fetchByChannel).map(([id, fetch]) => [id, {
    id,
    name: id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch },
  }]));
  const guild = {
    members: { me: { id: "bot" }, fetchMe: async () => ({ id: "bot" }) },
    channels: {
      fetch: async (id) => id ? channelMap.get(id) : channelMap,
    },
  };
  return { guilds: { cache: new Map([["123456789012345678", guild]]), fetch: async () => guild } };
}

const config = {
  enabled: true,
  sqliteFirstEnabled: true,
  isSqliteFirstGuild: (guildId) => guildId === "123456789012345678",
  maxRetries: 2,
  stallSeconds: 120,
  batchSize: 100,
  maxPagesPerChannel: 100,
};
const identity = { hostId: "test-host", instanceId: "test-instance" };
const logger = { info() {}, warn() {} };

test("history batch records are provenance-tagged without operational-log fields", () => {
  const records = messageBatchRecords([discordMessage("1"), { ...discordMessage("2"), author: { id: "2", bot: true } }], {
    guildId: "123456789012345678",
    channelId: "223456789012345678",
    channelName: "general",
    jobId: 9,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].source, "history_import");
  assert.equal(records[0].importJobId, 9);
  assert.equal(Object.hasOwn(records[0], "token"), false);
});

test("worker saves a batch before checkpoint completion", async () => {
  const channelProgress = { id: 11, channelId: "general", channelName: "general", nextBeforeMessageId: null };
  const repository = createFakeRepository({ channels: [channelProgress] });
  const client = createDiscordClient({ general: async () => collection([discordMessage("300"), discordMessage("200")]) });
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  await worker.poll();
  assert.equal(repository.state.saved.length, 1);
  assert.equal(repository.state.saved[0].nextBeforeMessageId, "200");
  assert.equal(repository.state.settled.at(-1).status, "completed");
  assert.equal(repository.state.completed, true);
});

test("checkpoint resume passes the persisted before snowflake to Discord", async () => {
  let options;
  const repository = createFakeRepository({ channels: [{ id: 12, channelId: "archive", channelName: "archive", nextBeforeMessageId: "500" }] });
  const client = createDiscordClient({ archive: async (value) => { options = value; return collection([]); } });
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  await worker.poll();
  assert.equal(options.before, "500");
});

test("one forbidden channel fails safely while the next channel completes", async () => {
  const repository = createFakeRepository({ channels: [
    { id: 13, channelId: "staff", channelName: "staff" },
    { id: 14, channelId: "general", channelName: "general" },
  ] });
  const client = createDiscordClient({
    staff: async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); },
    general: async () => collection([]),
  });
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  await worker.poll();
  assert.equal(repository.state.settled.some((item) => item.status === "failed" && item.safe.code === "DISCORD_FORBIDDEN"), true);
  assert.equal(repository.state.settled.some((item) => item.status === "completed"), true);
  assert.equal(repository.state.completed, true);
});

test("worker honors cancel only at a batch boundary", async () => {
  let boundaryChecks = 0;
  const repository = createFakeRepository({
    channels: [{ id: 15, channelId: "general", channelName: "general" }],
    control: () => {
      boundaryChecks += 1;
      return { status: "running", cancelRequested: boundaryChecks >= 4, pauseRequested: false, skipRequested: false };
    },
  });
  const client = createDiscordClient({ general: async () => collection(Array.from({ length: 100 }, (_, index) => discordMessage(String(1000 - index)))) });
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  await worker.poll();
  assert.equal(repository.state.saved.length, 1);
  assert.equal(repository.state.cancelled, true);
});

test("worker honors pause only after the current batch checkpoint is saved", async () => {
  let boundaryChecks = 0;
  const repository = createFakeRepository({
    channels: [{ id: 16, channelId: "general", channelName: "general" }],
    control: () => {
      boundaryChecks += 1;
      return { status: "running", cancelRequested: false, pauseRequested: boundaryChecks >= 4, skipRequested: false };
    },
  });
  const client = createDiscordClient({ general: async () => collection(Array.from({ length: 100 }, (_, index) => discordMessage(String(2000 - index)))) });
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  await worker.poll();
  assert.equal(repository.state.saved.length, 1);
  assert.equal(repository.state.paused, true);
  assert.equal(repository.state.completed, false);
});

test("worker skips only the selected channel and continues the job", async () => {
  const repository = createFakeRepository({
    channels: [
      { id: 17, channelId: "skip-me", channelName: "skip-me" },
      { id: 18, channelId: "general", channelName: "general" },
    ],
    control: (_jobId, channelId) => ({
      status: "running",
      cancelRequested: false,
      pauseRequested: false,
      skipRequested: channelId === 17,
    }),
  });
  const client = createDiscordClient({
    "skip-me": async () => { throw new Error("skipped channel must not be fetched"); },
    general: async () => collection([]),
  });
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  await worker.poll();
  assert.equal(repository.state.settled.some((item) => item.channelId === 17 && item.status === "skipped"), true);
  assert.equal(repository.state.settled.some((item) => item.channelId === 18 && item.status === "completed"), true);
  assert.equal(repository.state.completed, true);
});

test("stale recovery emits only safe lifecycle audit information", async () => {
  const repository = createFakeRepository({
    channels: [],
    staleJobs: [{ id: 19, guildId: "123456789012345678", version: 3 }],
  });
  const client = createDiscordClient({});
  const worker = createMessageHistoryImportWorker({ repository, discordClient: client, config, identity, logger, sleep: async () => {} });
  const recovered = await worker.recoverStaleJobs();
  assert.equal(recovered.length, 1);
  assert.deepEqual(repository.state.events.at(-1), {
    jobId: 19,
    guildId: "123456789012345678",
    eventType: "IMPORT_JOB_STALLED",
    safeErrorCode: "WORKER_HEARTBEAT_STALE",
  });
});

test("worker uses SQLite saveBatch and never directly inserts Cloud raw messages", async () => {
  const source = await readFile(new URL("../lib/message-history-import-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /requireLocal\(guildId\)\.saveBatch/);
  assert.match(source, /WITH gate AS[\s\S]*channel_update AS[\s\S]*UPDATE "history_import_job"/);
  assert.doesNotMatch(source, /INSERT INTO "discord_message"/);
  assert.doesNotMatch(source, /Promise\.all\([^)]*processChannel/);
});
