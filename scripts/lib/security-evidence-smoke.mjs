// Development-only entrypoint. Never imported by discord-bot.mjs / Web / Worker.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits, REST, Routes } from 'discord.js';
import { createLocalStorage } from '../../lib/storage/index.mjs';
import { createSecurityAuditService } from '../../lib/security-local-first.mjs';
import { createTimeoutIncidentService } from '../../lib/timeout-incidents.mjs';
import { sendTimeoutIncidentLog, timeoutLogPayload } from '../../lib/timeout-discord-log.mjs';
import { createSecurityEvidenceHandler, privateReportChannel, reportReceiverConfig } from '../../lib/security-evidence-interactions.mjs';
import { createFalsePositiveReports, securityId } from '../../lib/security-evidence.mjs';
import { createSecurityReportDelivery, securityReportRestOptions } from '../../lib/security-report-delivery.mjs';

// Public Production invite Application ID, verified from the live landing page
// on 2026-10-22. Not a credential. Update this deny-list if Production changes.
export const PRODUCTION_BOT_IDS = Object.freeze(['1523938138194444408']);
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fail = code => { throw new Error(code); };
export function smokeConfig(env) {
  if (env.NODE_ENV === 'production' || env.VERCEL || env.VERCEL_ENV || env.CI
    || ['NUVILOVIEW_BOT_TOKEN', 'DATABASE_URL', 'WEB_AUTH_SUPABASE_DATABASE_URL', 'TURSO_AUTH_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY', 'LOCAL_STORAGE_PATH', 'NUVILOVIEW_PROJECT_ROOT'].some(k => env[k])) fail('SMOKE_PRODUCTION_ENV_DENIED');
  const session = env.SECURITY_SMOKE_SESSION;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(session ?? '')) fail('SMOKE_SESSION_REQUIRED');
  const appId = env.SECURITY_SMOKE_APPLICATION_ID, guildId = env.SECURITY_SMOKE_GUILD_ID,
    channelId = env.SECURITY_SMOKE_LOG_CHANNEL_ID;
  if (![appId, guildId, channelId].every(securityId) || PRODUCTION_BOT_IDS.includes(appId)) fail('SMOKE_TEST_IDS_REQUIRED');
  const roleIds = (env.SECURITY_SMOKE_OPERATOR_ROLE_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (roleIds.length > 20 || roleIds.some(v => !securityId(v) || v === guildId)) fail('SMOKE_OPERATOR_ROLES_INVALID');
  const receiver = reportReceiverConfig(env);
  if ((env.SECURITY_REPORT_GUILD_ID || env.SECURITY_REPORT_CHANNEL_ID || env.SECURITY_REPORT_RECEIVER_ROLE_IDS) && !receiver) fail('SMOKE_RECEIVER_INVALID');
  return { session, appId, guildId, channelId, roleIds: [...new Set(roleIds)], receiver };
}

export function openSmokeState(config, { root = repositoryRoot, now = () => Date.now() } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.session ?? '') || PRODUCTION_BOT_IDS.includes(config.appId)) fail('SMOKE_UNSAFE_SESSION');
  const base = path.resolve(root, 'output', 'security-evidence-smoke');
  const directory = path.join(base, config.session);
  // Every descendant must be a real directory. Reject link/reparse-point and
  // hard-linked DB/sidecar files; an existing Production SQLite cannot be adopted.
  for (const entry of [path.join(root, 'output'), base, directory]) {
    if (!fs.existsSync(entry)) fs.mkdirSync(entry, { mode: 0o700 });
    if (fs.lstatSync(entry).isSymbolicLink() || !fs.statSync(entry).isDirectory()) fail('SMOKE_UNSAFE_PATH');
  }
  const databasePath = path.join(directory, 'smoke.sqlite');
  const markerPath = path.join(directory, 'session.json');
  for (const name of ['session.json', 'run.lock', 'smoke.sqlite', 'smoke.sqlite-wal', 'smoke.sqlite-shm']) {
    const target = path.join(directory, name);
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || info.nlink !== 1 || !info.isFile())) fail('SMOKE_UNSAFE_PATH');
  }
  if (fs.existsSync(databasePath) && !fs.existsSync(markerPath)) fail('SMOKE_UNMARKED_DATABASE');
  const marker = { kind: 'ISOLATED_SECURITY_EVIDENCE_SMOKE_V1', ...config };
  if (fs.existsSync(markerPath)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(markerPath, 'utf8'))) !== JSON.stringify(marker)) fail('SMOKE_SESSION_CONFIG_CHANGED');
  } else fs.writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  const lock = path.join(directory, 'run.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now() }), { mode: 0o600, flag: 'wx' });
  let storage;
  try {
    storage = createLocalStorage({ databasePath, now }); // no provider definitions, no sync process
    const baseAudit = createSecurityAuditService({ storage, now });
    const audit = { ...baseAudit, recordIncidentEvent: input => baseAudit.recordIncidentEvent({ ...input,
      payload: { ...input.payload, smokeFixture: true } }) };
    const incidents = createTimeoutIncidentService({ audit, now, version: '0.0.0-smoke' });
    const sourceId = String(100000000000000000n + BigInt('0x' + createHash('sha256').update(config.session).digest('hex').slice(0, 14)));
    const begin = () => incidents.begin({ guildId: config.guildId, userId: config.appId, messageId: sourceId,
      channelId: config.channelId, occurredAt: now(), signals: ['messages'], count: 8, windowSeconds: 10 });
    // Stable ID without creating a row during --inspect / resume.
    const incidentId = `timeout-${createHash('sha256').update(`${config.guildId}:${config.appId}:${sourceId}`).digest('hex').slice(0, 40)}`;
    const query = async (sql, parameters) => {
      if (parameters?.[0] !== config.guildId) fail('SMOKE_QUERY_GUILD_DENIED');
      if (sql === 'SELECT role_ids FROM guild_security_operator WHERE guild_id=$1') return { rows: [{ role_ids: config.roleIds }] };
      if (sql === 'SELECT channel_id FROM guild_security_log WHERE guild_id=$1::text') return { rows: [{ channel_id: config.channelId }] };
      fail('SMOKE_QUERY_DENIED');
    };
    return { storage, audit, incidents, incidentId, query,
      seed() {
        const result = begin();
        if (result.inserted) {
          incidents.claimTimeout(config.guildId, incidentId);
          incidents.timeoutApi(config.guildId, incidentId, 86400_000);
          // Synthetic outcome only: there is deliberately NO Discord moderation call.
          incidents.timeoutResult(config.guildId, incidentId, 'success', null, now() + 86400_000);
        }
        return result;
      },
      inspect() { return createFalsePositiveReports({ audit }).state(config.guildId, incidentId); },
      close() { storage.close(); fs.unlinkSync(lock); },
    };
  } catch (error) { storage?.close(); fs.unlinkSync(lock); throw error; }
}

export function smokeLogPayload(...args) {
  const payload = timeoutLogPayload(...args);
  payload.embeds[0].setTitle('【隔離テスト】スパム検知');
  payload.embeds[0].setDescription('これは合成記録です。DiscordへのTimeout操作は行っていません。\n\n' + payload.embeds[0].data.description);
  return payload;
}

export function registerSmokeInteractions(client, config, state, { deliver = createSecurityReportDelivery({ client }) } = {}) {
  const handler = createSecurityEvidenceHandler({ ...state, client, receiver: config.receiver,
    sendReport: (channel, payload) => deliver(channel, { ...payload,
      content: '【隔離テスト／合成記録】\n' + payload.content }) });
  const pending = new Set();
  const handle = async interaction => {
    if (!interaction.isButton?.() || !interaction.customId.startsWith('nvsec:')) return;
    if (interaction.guildId !== config.guildId) {
      await interaction.reply({ content: 'この検証Botは指定されたテストGuildだけで使えます。', flags: 64, allowedMentions: { parse: [] } }).catch(() => {}); return;
    }
    await handler(interaction);
  };
  const listener = interaction => {
    const task = handle(interaction);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  client.on(Events.InteractionCreate, listener);
  return async () => {
    client.off(Events.InteractionCreate, listener);
    await Promise.allSettled([...pending]);
  };
}

export async function runSmoke({ env = process.env, args = process.argv.slice(2),
  makeClient = () => new Client({ intents: [GatewayIntentBits.Guilds], rest: securityReportRestOptions }),
  identify = token => new REST(securityReportRestOptions).setToken(token).get(Routes.user()),
  root = repositoryRoot, print = value => console.log(JSON.stringify(value)) } = {}) {
  const config = smokeConfig(env);
  if (args.includes('--plan')) { print({ mode: 'ISOLATED_ONLY', receiver: config.receiver ? 'CONFIGURED' : 'UNSET', network: 'NONE', timeoutCalls: 0 }); return; }
  if (!args.includes('--inspect') && (!args.includes('--connect-test-bot') || !env.SECURITY_SMOKE_BOT_TOKEN)) fail('SMOKE_EXPLICIT_CONNECT_REQUIRED');
  const state = openSmokeState(config, { root });
  if (args.includes('--inspect')) { try { print({ ...state.inspect(), synthetic: true }); } finally { state.close(); } return; }
  const client = makeClient();
  let unregister = () => {};
  try {
    // Identity check is READ-ONLY, before connecting the Gateway or posting.
    const self = await identify(env.SECURITY_SMOKE_BOT_TOKEN);
    if (self.id !== config.appId || !self.bot || PRODUCTION_BOT_IDS.includes(self.id)) fail('SMOKE_BOT_ID_MISMATCH');
    client.on(Events.Error, () => print({ error: 'SMOKE_DISCORD_CLIENT_ERROR' }));
    let readyTimer;
    const ready = new Promise((resolve, reject) => {
      client.once(Events.ClientReady, resolve);
      readyTimer = setTimeout(() => reject(new Error('SMOKE_GATEWAY_TIMEOUT')), 30_000);
    });
    // Attach the rejection handler before login; no unhandled timeout rejection.
    try { await Promise.all([client.login(env.SECURITY_SMOKE_BOT_TOKEN), ready]); }
    finally { clearTimeout(readyTimer); }
    const guild = await client.guilds.fetch({ guild: config.guildId, force: true });
    if (guild.id !== config.guildId) fail('SMOKE_GUILD_MISMATCH');
    const channel = await guild.channels.fetch(config.channelId, { force: true });
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== guild.id) fail('SMOKE_CHANNEL_MISMATCH');
    const botMember = await guild.members.fetchMe({ force: true });
    if (botMember.id !== config.appId || !channel.permissionsFor(botMember)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
    ])) fail('SMOKE_CHANNEL_PERMISSION_DENIED');
    // Validate receiver before seeding/posting; there is no public fallback.
    if (config.receiver) await privateReportChannel(client, config.receiver);
    unregister = registerSmokeInteractions(client, config, state);
    if (args.includes('--post-synthetic')) {
      state.seed();
      const result = await sendTimeoutIncidentLog({ ...state, guild, targetMember: { displayName: '合成テスト対象（Bot自身）', user: client.user }, renderPayload: smokeLogPayload });
      print({ syntheticLog: result.status, timeoutCalls: 0 });
    }
    print({ ready: true, synthetic: true, commandsRegistered: 0, timeoutCalls: 0, stop: 'Ctrl+C' });
    await new Promise(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await unregister(); await client.destroy(); state.close(); }
}
