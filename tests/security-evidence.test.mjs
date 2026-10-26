import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createSecurityAuditService } from '../lib/security-local-first.mjs';
import { createFalsePositiveReports, EVIDENCE_MAX_BYTES, EVIDENCE_TTL_MS, evidenceText, safeEvidence, reportIdFor } from '../lib/security-evidence.mjs';
import { reportReceiverConfig } from '../lib/security-evidence-interactions.mjs';
import { parseEvidenceAction } from '../lib/security-evidence-components.mjs';
import { evidenceFixture, receiver, at } from './helpers/security-evidence-fixture.mjs';
import { guildId, roleId } from './helpers/security-operator-fixture.mjs';

for (const kind of ['owner', 'admin', 'operator']) test(`${kind}: safe evidence and current authorization on every click`, async () => {
  const f = evidenceFixture({ kind }); try {
    await f.handler()(f.interaction());
    assert.equal(f.replies.length, 1); assert.equal(f.sends.length, 0);
    assert.equal(f.calls[0][0], 'ack'); assert.ok(f.calls.includes('query'));
    assert.ok(f.replies[0].files[0].attachment.length < EVIDENCE_MAX_BYTES);
    assert.match(f.replies[0].files[0].attachment.toString(), /短時間の連続投稿/);
    assert.ok(f.audit.getModerationAudit(`${f.id}:report_view_${f.member.id}`));
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
  } finally { f.storage.close(); }
});
for (const kind of ['member', 'manage']) test(`${kind}: unauthorized evidence/report sends zero external messages`, async () => {
  const f = evidenceFixture({ kind }); try {
    for (const action of ['e', 'r']) await f.handler()(f.interaction(action));
    assert.ok(f.replies.every(p => /運営権限/.test(p.content))); assert.equal(f.sends.length, 0);
    assert.equal(f.audit.getModerationAudit(`${f.id}:report_claim`), null);
  } finally { f.storage.close(); }
});
for (const failure of ['deleted role', 'removed member role', 'managed role', 'revoked DB role', 'DB down', 'member fetch', 'foreign incident', 'missing incident', 'bad custom ID',
  'different message', 'different channel', 'different author', 'source deleted', 'source edited', 'unexpected attachment', 'source hidden', 'old incident', 'old log without fingerprint']) {
  test(`${failure}: fail closed, no evidence disclosure / external send`, async () => {
    const f = evidenceFixture({ kind: failure.includes('role') ? 'operator' : 'owner' }); try {
      const i = f.interaction('r'); const overrides = {};
      if (failure === 'deleted role') f.guild.roles.cache.clear();
      if (failure === 'removed member role') f.member.roles.cache.clear();
      if (failure === 'managed role') f.role.managed = true;
      if (failure === 'revoked DB role') overrides.query = async () => ({ rows: [] });
      if (failure === 'DB down') overrides.query = async () => { throw new Error('postgresql://secret'); };
      if (failure === 'member fetch') f.guild.members.fetch = async () => { throw new Error('token-secret'); };
      if (failure === 'foreign incident') i.guildId = '100000000000000008';
      if (failure === 'missing incident') i.customId = 'nvsec:r:timeout-' + '0'.repeat(40);
      if (failure === 'bad custom ID') i.customId = 'nvsec:r:../../bad';
      if (failure === 'different message') i.message = { ...i.message, id: '500000000000000008' };
      if (failure === 'different channel') i.channelId = '400000000000000008';
      if (failure === 'different author') i.message = { ...i.message, author: { id: '600000000000000008' } };
      if (failure === 'source deleted') f.sourceChannel.messages.fetch = async () => null;
      if (failure === 'source edited') f.source.embeds[0].description = 'edited body';
      if (failure === 'unexpected attachment') f.source.attachments.set('x', {});
      if (failure === 'source hidden') f.sourceChannel.permissionsFor = () => ({ has: () => false });
      if (failure === 'old incident') overrides.now = () => at + EVIDENCE_TTL_MS + 1;
      if (failure === 'old log without fingerprint') overrides.incidents = { snapshot: (...args) => {
        const s = f.incidents.snapshot(...args); s.log.payload.fingerprint = null; return s;
      } };
      await f.handler(overrides)(i);
      assert.equal(f.sends.length, 0); assert.equal(f.replies[0].files, undefined);
      assert.doesNotMatch(JSON.stringify(f.replies), /postgresql|token-secret/);
      assert.equal(f.audit.getModerationAudit(`${f.id}:report_claim`), null);
    } finally { f.storage.close(); }
  });
}

test('ACK precedes slow DB, and ACK failure / already acknowledged never retries or discloses', async () => {
  const f = evidenceFixture(); try {
    let release; const wait = new Promise(resolve => { release = resolve; });
    const h = f.handler({ query: async () => { await wait; return { rows: [] }; } });
    const task = h(f.interaction()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls[0][0], 'ack'); assert.equal(f.replies.length, 0);
    release(); await task; assert.equal(f.replies.length, 1);
    for (const options of [{ deferred: true }, { replied: true }, { deferReply: async () => { throw { code: 10062 }; } }]) {
      await h(Object.assign(f.interaction('r'), options));
    }
    assert.equal(f.replies.length, 1); assert.equal(f.sends.length, 0);
  } finally { f.storage.close(); }
});

test('allow-listed TXT is bounded UTF8, no names/raw messages/secrets/current policy, unknown historical data explicit', () => {
  const f = evidenceFixture(); try {
    const s = f.incidents.snapshot(guildId, f.id);
    Object.assign(s.detection.payload, { reason: 'RAW_SECRET', rawMessage: 'RAW_MESSAGE', otherGuild: 'OTHER_GUILD', botVersion: 'token-secret', botCommit: 'TOKEN', strength: 99 });
    s.timeout.payload.errorCode = 'SECRET_ERROR';
    const txt = evidenceText(s, { reportId: reportIdFor(guildId, f.id), reporterId: f.member.id, reportedAt: at });
    assert.ok(txt.length < EVIDENCE_MAX_BYTES); assert.equal(Buffer.from(txt.toString('utf8')).compare(txt), 0);
    assert.doesNotMatch(txt.toString(), /RAW_SECRET|RAW_MESSAGE|OTHER_GUILD|token-secret|SECRET_ERROR|99/);
    assert.match(txt.toString(), /SUSPECTED_FALSE_POSITIVE/); assert.match(txt.toString(), /durationSeconds: 86400/);
    assert.match(txt.toString(), /policyStrength: UNKNOWN/); assert.equal(safeEvidence(s).runtime.version, 'UNKNOWN');
    assert.equal(safeEvidence(s).runtime.commit, 'UNKNOWN'); assert.equal(parseEvidenceAction('arbitrary'), null);
    assert.notEqual(reportIdFor(guildId, f.id), reportIdFor('100000000000000002', f.id));
  } finally { f.storage.close(); }
});

test('successful report sends once, records destination/message and immutable result, never untimeouts', async () => {
  const f = evidenceFixture(); try {
    const h = f.handler(); await Promise.all([h(f.interaction('r')), h(f.interaction('r'))]);
    assert.equal(f.sends.length, 1);
    const reportId = reportIdFor(guildId, f.id), p = f.sends[0];
    assert.equal(p.files[0].name, `nuviloview-false-positive-${reportId}.txt`);
    assert.match(p.files[0].attachment.toString(), new RegExp(`Reported By: ${f.member.id}`));
    assert.equal(p.enforceNonce, true); assert.deepEqual(p.allowedMentions, { parse: [] });
    const reports = createFalsePositiveReports({ audit: f.audit });
    assert.equal(reports.state(guildId, f.id).status, 'SENT');
    assert.equal(f.audit.getModerationAudit(`${f.id}:report_claim`).payload.destinationChannelId, receiver.channelId);
    assert.equal(f.audit.getModerationAudit(`${f.id}:report_sent`).payload.messageId, '500000000000000009');
    assert.equal(f.incidents.snapshot(guildId, f.id).timeout.status, 'success');
    assert.match(f.replies.find(p => /送信したよ/.test(p.content)).content, /解除は行っていません/);
  } finally { f.storage.close(); }
});

test('missing receiver is friendly and does not claim a report; config never guesses developer Guild', async () => {
  const f = evidenceFixture(); try {
    await f.handler({ receiver: null })(f.interaction('r'));
    assert.equal(f.replies[0].content, '開発者への送信先が設定されていないよ。');
    assert.equal(f.audit.getModerationAudit(`${f.id}:report_claim`), null);
    assert.equal(reportReceiverConfig({ DISCORD_DEV_GUILD_ID: guildId }), null);
    assert.equal(reportReceiverConfig({ SECURITY_REPORT_GUILD_ID: receiver.guildId, SECURITY_REPORT_CHANNEL_ID: 'bad' }), null);
    assert.deepEqual(reportReceiverConfig({ SECURITY_REPORT_GUILD_ID: receiver.guildId, SECURITY_REPORT_CHANNEL_ID: receiver.channelId }), receiver);
  } finally { f.storage.close(); }
});
for (const failure of ['permissions', 'public', 'public role', 'member grant', 'wrong destination', 'missing channel', 'unavailable roles']) test(`receiver ${failure}: reject without external send or claim`, async () => {
  const f = evidenceFixture(); try {
    if (failure === 'permissions') f.privateChannel.permissionsFor = () => ({ has: () => false });
    if (failure === 'public') f.privateChannel.permissionOverwrites.cache.clear();
    if (['public role', 'member grant'].includes(failure)) {
      f.privateChannel.permissionOverwrites.cache.set(roleId, { id: roleId, type: failure === 'member grant' ? 1 : 0,
        allow: { has: p => p === PermissionFlagsBits.ViewChannel } });
      f.receiverGuild.roles.cache.set(roleId, { id: roleId, managed: false, permissions: { has: () => false } });
    }
    if (failure === 'wrong destination') f.privateChannel.guildId = guildId;
    if (failure === 'missing channel') f.receiverGuild.channels.fetch = async () => null;
    if (failure === 'unavailable roles') f.receiverGuild.roles.fetch = async () => { throw new Error('secret'); };
    await f.handler()(f.interaction('r')); assert.equal(f.sends.length, 0);
    assert.equal(f.audit.getModerationAudit(`${f.id}:report_claim`), null);
    assert.doesNotMatch(JSON.stringify(f.replies), /secret/);
  } finally { f.storage.close(); }
});

for (const [error, expected] of [[{ status: 403, message: 'SECRET' }, 'FAILED'], [{ status: 429 }, 'FAILED'], [{ status: 503 }, 'UNKNOWN'], [new Error('SECRET'), 'UNKNOWN']]) {
  test(`send outcome ${expected}: no retry, no false success, sanitized audit`, async () => {
    const f = evidenceFixture(); try {
      let attempts = 0; f.privateChannel.send = async () => { attempts++; throw error; };
      const h = f.handler(); await h(f.interaction('r')); await h(f.interaction('r'));
      assert.equal(attempts, 1); assert.equal(createFalsePositiveReports({ audit: f.audit }).state(guildId, f.id).status, expected);
      assert.doesNotMatch(JSON.stringify(f.replies), /送信したよ|SECRET/);
      assert.doesNotMatch(JSON.stringify(f.audit.getModerationAudit(`${f.id}:report_result`)), /SECRET/);
    } finally { f.storage.close(); }
  });
}

test('no success reply until Discord and durable result succeed', async () => {
  const f = evidenceFixture(); try {
    let release; const wait = new Promise(resolve => { release = resolve; });
    const original = f.privateChannel.send; f.privateChannel.send = async p => { await wait; return original(p); };
    const task = f.handler()(f.interaction('r')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.replies.length, 0); assert.equal(createFalsePositiveReports({ audit: f.audit }).state(guildId, f.id).status, 'UNKNOWN');
    release(); await task; assert.match(f.replies[0].content, /送信したよ/);
  } finally { f.storage.close(); }
});

test('restart preserves report claims and buttons; a post-send persistence failure never resends', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nuviloview-prc-')); const databasePath = join(directory, 'test.sqlite');
  let f;
  try {
    f = evidenceFixture({ databasePath, auditWrapper: a => ({ ...a, recordIncidentEvent: input => {
      if (input.action === 'report_sent') throw new Error('local disk failed'); return a.recordIncidentEvent(input);
    } }) });
    const id = f.id; await f.handler()(f.interaction('r')); assert.equal(f.sends.length, 1); f.storage.close();
    f = evidenceFixture({ databasePath, existing: true });
    await f.handler()(f.interaction('r')); assert.equal(f.sends.length, 0);
    assert.equal(createFalsePositiveReports({ audit: f.audit }).state(guildId, id).status, 'UNKNOWN');
    await f.handler()(f.interaction()); assert.ok(f.replies[1].files);
  } finally { f?.storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rate limit / concurrency bound protect memory and DB without missing ACK', async () => {
  const f = evidenceFixture(); try {
    await f.handler({ allow: () => false })(f.interaction());
    assert.match(f.replies[0].content, /少し待って/); assert.equal(f.calls.length, 1);
    let release; const wait = new Promise(resolve => { release = resolve; });
    const h = f.handler({ maxConcurrent: 1, query: async () => { await wait; return { rows: [] }; } });
    const pending = h(f.interaction()); await new Promise(resolve => setImmediate(resolve));
    await h(f.interaction('r')); assert.match(f.replies[1].content, /少し待って/);
    release(); await pending; assert.equal(f.sends.length, 0);
  } finally { f.storage.close(); }
});

test('report audit/Outbox persistence is atomic; failed claim cannot cause a send', async () => {
  const f = evidenceFixture();
  try {
    const failedOutboxAudit = createSecurityAuditService({ storage: { ...f.storage,
      outbox: { enqueue() { throw new Error('isolated Outbox failure'); } } } });
    await f.handler({ audit: failedOutboxAudit })(f.interaction('r'));
    assert.equal(f.sends.length, 0); assert.equal(f.audit.getModerationAudit(`${f.id}:report_claim`), null);
    await f.handler()(f.interaction('r')); assert.equal(f.sends.length, 1);
  } finally { f.storage.close(); }
});

test('independent SQLite connections / handlers elect one durable report winner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nuviloview-report-race-'));
  const databasePath = join(directory, 'test.sqlite');
  let first, second;
  try {
    first = evidenceFixture({ databasePath }); second = evidenceFixture({ databasePath, existing: true });
    await Promise.all([first.handler()(first.interaction('r')), second.handler()(second.interaction('r'))]);
    assert.equal(first.sends.length + second.sends.length, 1);
    assert.equal(createFalsePositiveReports({ audit: second.audit }).state(guildId, first.id).status, 'SENT');
  } finally {
    first?.storage.close(); second?.storage.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('live log with altered button ID/style or spoofed stage cannot authorize report', async () => {
  for (const mutation of ['custom ID', 'style', 'timeout failure', 'stage ID']) {
    const f = evidenceFixture(); try {
      const overrides = {};
      if (mutation === 'custom ID') f.source.components[0].components[0].custom_id = 'nvsec:e:timeout-' + '0'.repeat(40);
      if (mutation === 'style') f.source.components[0].components[0].style = 4;
      if (mutation === 'timeout failure' || mutation === 'stage ID') overrides.incidents = { snapshot: (...args) => {
        const s = f.incidents.snapshot(...args);
        if (mutation === 'timeout failure') s.timeout.status = 'failed'; else s.log.eventId = 'spoofed';
        return s;
      } };
      await f.handler(overrides)(f.interaction('r'));
      assert.equal(f.sends.length, 0); assert.equal(f.replies[0].files, undefined);
    } finally { f.storage.close(); }
  }
});

test('snapshot rejects foreign stage rows even when the parent Incident matches', async () => {
  const f = evidenceFixture(); try {
    await f.handler({ incidents: { snapshot: (...args) => {
      const s = f.incidents.snapshot(...args); s.sent.guildId = '100000000000000008'; return s;
    } } })(f.interaction('r'));
    assert.equal(f.sends.length, 0); assert.equal(f.replies[0].files, undefined);
  } finally { f.storage.close(); }
});

test('bounded limiter expires entries and rejects a saturated key set', async () => {
  const { createInteractionLimiter } = await import('../lib/security-operators.mjs');
  let now = 0; const allow = createInteractionLimiter({ now: () => now, maxEntries: 2, intervalMs: 5000 });
  assert.equal(allow('a'), true); assert.equal(allow('a'), false); assert.equal(allow('b'), true);
  assert.equal(allow('c'), false); now = 5000; assert.equal(allow('c'), true);
});

test('runtime registers persistent component path; report modules have no timeout execution, ENV dump, temp files or new slash command', () => {
  const runtime = readFileSync(new URL('../discord-bot.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /customId\.startsWith\("nvsec:"\)/); assert.match(runtime, /await handleSecurityEvidence\(interaction\)/);
  for (const path of ['security-evidence.mjs', 'security-evidence-interactions.mjs']) {
    const source = readFileSync(new URL(`../lib/${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.timeout\(|writeFile|console\.|SlashCommandBuilder|process\.env/);
  }
});
