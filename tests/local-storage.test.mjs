import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertStorageContract,
  createLocalStorage,
  createStableEventId,
  createStorage,
  StorageClosedError,
  StorageDisabledError,
  StorageReadOnlyError,
} from "../lib/storage/index.mjs";

function temporaryDatabase(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-local-storage-"));
  const databasePath = join(directory, "data", "nuviloview.sqlite");
  const storage = createLocalStorage({ databasePath, ...options });
  t.after(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, storage };
}

test("feature flags default OFF without creating a database file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-storage-off-"));
  const databasePath = join(directory, "data", "disabled.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const storage = createStorage({
    env: {
      LOCAL_STORAGE_ENABLED: "false",
      LOCAL_STORAGE_WRITE_ENABLED: "false",
      LOCAL_STORAGE_PATH: databasePath,
    },
    cwd: directory,
  });
  assertStorageContract(storage);
  assert.equal(storage.enabled, false);
  assert.equal(storage.health.getStatus().open, false);
  assert.equal(existsSync(databasePath), false);
  assert.throws(
    () => storage.messages.upsert({}),
    (error) => error instanceof StorageDisabledError,
  );
});

test("SQLite initialization applies the versioned schema exactly once", (t) => {
  const { databasePath, storage } = temporaryDatabase(t);
  assert.equal(existsSync(databasePath), true);
  assert.equal(storage.close(), true);

  const reopened = createLocalStorage({ databasePath });
  reopened.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  for (const table of [
    "storage_meta",
    "migration_history",
    "message_events",
    "reaction_events",
    "voice_events",
    "member_events",
    "security_audit",
    "local_guild_config",
    "sync_metadata",
    "sync_outbox",
    "sync_dead_letter",
    "message_event_log",
    "local_message_daily_stats",
    "local_message_active_member",
    "local_message_recent_activity",
    "message_domain_metrics",
  ]) {
    assert.equal(tables.has(table), true, table);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM migration_history").get().count,
    3,
  );
  database.close();
});

test("WAL, foreign keys, busy timeout, and integrity health are enabled", (t) => {
  const { storage } = temporaryDatabase(t);
  const status = storage.health.getStatus();
  assert.equal(status.open, true);
  assert.equal(status.journalMode, "wal");
  assert.equal(status.foreignKeys, true);
  assert.equal(status.busyTimeoutMs, 5_000);
  assert.equal(status.schemaVersion, 3);
  assert.equal(status.integrity.ok, true);
});

test("message repository inserts, upserts, and marks a stable identity deleted", (t) => {
  const { storage } = temporaryDatabase(t);
  const created = storage.messages.upsert({
    guildId: "100",
    channelId: "200",
    messageId: "300",
    authorId: "400",
    content: "first",
    occurredAt: 1_000,
    payload: { source: "gateway" },
  });
  const updated = storage.messages.upsert({
    guildId: "100",
    channelId: "200",
    messageId: "300",
    authorId: "400",
    eventType: "update",
    content: "second",
    occurredAt: 2_000,
  });
  assert.equal(created.eventId, "message:100:300");
  assert.equal(updated.eventId, created.eventId);
  assert.equal(updated.content, "second");
  assert.equal(updated.eventType, "update");

  const deleted = storage.messages.markDeleted({
    guildId: "100",
    messageId: "300",
    occurredAt: 3_000,
  });
  assert.equal(deleted.eventType, "delete");
  assert.equal(deleted.content, null);
  assert.equal(deleted.deletedAt, 3_000);
});

test("analytics repositories deduplicate stable event IDs", (t) => {
  const { storage } = temporaryDatabase(t);
  const reaction = {
    guildId: "100",
    channelId: "200",
    messageId: "300",
    userId: "400",
    emojiKey: "wave",
    action: "add",
    occurredAt: 4_000,
  };
  assert.equal(storage.analytics.recordReactionEvent(reaction).inserted, true);
  assert.equal(storage.analytics.recordReactionEvent(reaction).inserted, false);

  assert.equal(
    storage.analytics.recordVoiceEvent({
      guildId: "100",
      channelId: "voice-1",
      userId: "400",
      sessionId: "session-1",
      eventType: "join",
      occurredAt: 5_000,
    }).inserted,
    true,
  );
  assert.equal(
    storage.analytics.recordMemberEvent({
      guildId: "100",
      userId: "400",
      eventType: "join",
      occurredAt: 6_000,
    }).inserted,
    true,
  );
});

test("storage transaction rolls back every repository write on failure", (t) => {
  const { storage } = temporaryDatabase(t);
  assert.throws(
    () =>
      storage.transaction(() => {
        storage.messages.upsert({
          guildId: "rollback-guild",
          channelId: "rollback-channel",
          messageId: "rollback-message",
          occurredAt: 7_000,
        });
        throw new Error("intentional rollback");
      }),
    /intentional rollback/,
  );
  assert.equal(
    storage.messages.getByIdentity("rollback-guild", "rollback-message"),
    null,
  );
});

test("security, moderation, guild config, and sync metadata contracts work", (t) => {
  const { storage } = temporaryDatabase(t);
  const audit = storage.security.appendAudit({
    guildId: "100",
    incidentId: "incident-1",
    category: "spam",
    severity: "medium",
    action: "timeout",
    status: "success",
    occurredAt: 8_000,
  });
  assert.equal(audit.inserted, true);
  assert.equal(
    storage.security.appendAudit({
      guildId: "100",
      incidentId: "incident-1",
      category: "spam",
      severity: "medium",
      action: "timeout",
      status: "success",
      occurredAt: 8_000,
    }).inserted,
    false,
  );
  assert.equal(
    storage.moderation.recordAction({
      guildId: "100",
      action: "kick",
      status: "denied",
      occurredAt: 8_100,
    }).category,
    "moderation",
  );

  storage.config.setLastKnownGuildPolicy({
    guildId: "100",
    version: 2,
    policy: { spamProtection: true },
    sourceUpdatedAt: 8_200,
  });
  storage.config.setLastKnownGuildPolicy({
    guildId: "100",
    version: 1,
    policy: { spamProtection: false },
    sourceUpdatedAt: 8_300,
  });
  assert.deepEqual(storage.config.getLastKnownGuildPolicy("100").policy, {
    spamProtection: true,
  });

  const sync = storage.syncMetadata.set({
    streamName: "messages",
    cursor: "cursor-1",
    state: "idle",
    lastSuccessAt: 8_400,
  });
  assert.equal(sync.cursor, "cursor-1");
  assert.equal(storage.syncMetadata.get("messages").lastSuccessAt, 8_400);
});

test("health API checks integrity, checkpoints WAL, and reports storage size", (t) => {
  const { storage } = temporaryDatabase(t);
  storage.messages.upsert({
    guildId: "100",
    channelId: "200",
    messageId: "health-message",
    occurredAt: 9_000,
  });
  assert.equal(storage.health.checkIntegrity().ok, true);
  const checkpoint = storage.health.checkpoint("PASSIVE");
  assert.equal(checkpoint.mode, "PASSIVE");
  assert.ok(checkpoint.logFrames >= 0);
  assert.ok(storage.health.getStorageSize().totalBytes > 0);
});

test("database data survives graceful close and reopen", (t) => {
  const { databasePath, storage } = temporaryDatabase(t);
  storage.messages.upsert({
    guildId: "100",
    channelId: "200",
    messageId: "persistent-message",
    content: "persisted",
    occurredAt: 10_000,
  });
  assert.equal(storage.close(), true);
  assert.equal(storage.close(), false);
  assert.throws(
    () => storage.health.checkIntegrity(),
    (error) => error instanceof StorageClosedError,
  );

  const reopened = createLocalStorage({ databasePath });
  assert.equal(
    reopened.messages.getByIdentity("100", "persistent-message").content,
    "persisted",
  );
  reopened.close();
});

test("write-disabled local storage remains readable but rejects repository writes", (t) => {
  const { storage } = temporaryDatabase(t, { writeEnabled: false });
  assert.equal(storage.health.getStatus().writeEnabled, false);
  assert.throws(
    () =>
      storage.messages.upsert({
        guildId: "100",
        channelId: "200",
        messageId: "300",
        occurredAt: 11_000,
      }),
    (error) => error instanceof StorageReadOnlyError,
  );
});

test("stable IDs are deterministic and long values are safely bounded", () => {
  const first = createStableEventId("reaction", ["100", "200", "wave", "add"]);
  const second = createStableEventId("reaction", ["100", "200", "wave", "add"]);
  assert.equal(first, second);
  const bounded = createStableEventId("security", ["x".repeat(500)]);
  assert.match(bounded, /^security:sha256:[a-f0-9]{64}$/);
});

test("Phase 3A connects only the guarded Message router to discord-bot.mjs", () => {
  const source = readFileSync(
    new URL("../discord-bot.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /createMessageDomainRouter/);
  assert.match(source, /messageRouter\.isLocalFirstGuild/);
  assert.doesNotMatch(source, /messageRouter\.(?:reaction|voice|member)/);
});
