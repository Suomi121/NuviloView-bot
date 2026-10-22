import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { incidentFixture, guildId, channelId, messageId } from './timeout-incident-fixture.mjs';
import { operatorFixture, roleId } from './security-operator-fixture.mjs';
import { timeoutLogPayload } from '../../lib/timeout-discord-log.mjs';
import { securityLogFingerprint } from '../../lib/security-evidence-components.mjs';
import { createSecurityEvidenceHandler } from '../../lib/security-evidence-interactions.mjs';

export const at = 1790000000000;
export const botId = '600000000000000001';
export const receiver = { guildId: '100000000000000009', channelId: '400000000000000009', roleIds: [] };
export function evidenceFixture({ kind = 'owner', databasePath, auditWrapper, existing = false, query, allow = () => true, maxConcurrent = 4 } = {}) {
  const f = incidentFixture({ databasePath, wrapAudit: auditWrapper });
  const id = f.begin().incidentId;
  if (!existing) {
    f.incidents.claimTimeout(guildId, id); f.incidents.timeoutApi(guildId, id, 86400_000);
    f.incidents.timeoutResult(guildId, id, 'success', null, at + 86400_000);
    f.incidents.claimLog(guildId, id); f.incidents.logSent(guildId, id, channelId, messageId);
  }
  const p = timeoutLogPayload(f.incidents.snapshot(guildId, id), { displayName: '@everyone', user: { username: 'safe' } }, channelId);
  if (!existing) f.incidents.logResult(guildId, id, 'sent', null, null, securityLogFingerprint(p));
  const o = operatorFixture({ kind });
  const source = { id: messageId, guildId, channelId, author: { id: botId }, content: '', attachments: new Map(),
    embeds: p.embeds.map(e => e.toJSON()), components: p.components.map(c => c.toJSON()) };
  const calls = [], replies = [], sends = [];
  const sourceChannel = { id: channelId, guildId, permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => source } };
  o.guild.channels = { fetch: async () => sourceChannel };
  const privateChannel = { id: receiver.channelId, guildId: receiver.guildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), permissionOverwrites: { cache: new Map([[receiver.guildId,
      { id: receiver.guildId, type: 0, deny: { has: p => p === PermissionFlagsBits.ViewChannel }, allow: { has: () => false } }]]) },
    send: async payload => { sends.push(payload); return { id: '500000000000000009', channelId: receiver.channelId, guildId: receiver.guildId }; } };
  const receiverGuild = { id: receiver.guildId, ownerId: '300000000000000009',
    roles: { cache: new Map(), fetch: async () => receiverGuild.roles.cache },
    members: { fetchMe: async () => ({ id: botId }) }, channels: { fetch: async () => privateChannel } };
  const client = { user: { id: botId }, guilds: { fetch: async () => receiverGuild } };
  const defaultQuery = async () => { calls.push('query'); return { rows: [{ role_ids: [roleId] }] }; };
  function interaction(action = 'e') {
    let acknowledged = false;
    return { ...o.interaction, channelId, message: source, customId: `nvsec:${action}:${id}`,
      deferReply: async payload => { assertNoRepeat(); calls.push(['ack', payload]); acknowledged = true; },
      editReply: async payload => { if (!acknowledged) throw new Error('EDIT_BEFORE_ACK'); replies.push(payload); },
      reply: async () => { throw new Error('UNEXPECTED_REPLY'); },
    };
    function assertNoRepeat() { if (acknowledged) throw new Error('DOUBLE_ACK'); }
  }
  const handler = (overrides = {}) => createSecurityEvidenceHandler({ audit: f.audit, incidents: f.incidents,
    query: query ?? defaultQuery, client, receiver, now: () => at + 1000, allow, maxConcurrent,
    sendReport: (channel, payload) => channel.send(payload), ...overrides });
  return { ...f, ...o, id, source, sourceChannel, receiverGuild, privateChannel, client, calls, replies, sends, interaction, handler };
}
