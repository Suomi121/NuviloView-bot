import { PermissionFlagsBits } from 'discord.js';
export const guildId = '100000000000000001', roleId = '200000000000000001', userId = '300000000000000001';
export function operatorFixture({ kind = 'member', managed = false } = {}) {
  const calls = [], replies = [];
  const role = { id: roleId, managed, tags: null };
  const guild = { id: guildId, ownerId: kind === 'owner' ? userId : '300000000000000009',
    fetch: async () => { calls.push('guild'); return guild; },
    roles: { cache: new Map([[roleId, role]]), fetch: async () => calls.push('roles') },
  };
  role.guild = guild;
  const member = { id: userId, guild,
    permissions: { has: permission => kind === 'admin' && permission === PermissionFlagsBits.Administrator || kind === 'manage' && permission === PermissionFlagsBits.ManageGuild },
    roles: { cache: new Map(kind === 'operator' ? [[roleId, role]] : []), highest: { comparePositionTo: () => 1 } },
  };
  guild.members = { fetch: async options => { calls.push(options); return member; }, fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => 1 } } }) };
  const interaction = { guild, guildId, user: { id: userId }, inGuild: () => true,
    options: { getSubcommand: () => 'add', getRole: () => role },
    deferReply: async () => {}, editReply: async payload => replies.push(payload),
  };
  return { interaction, guild, member, role, calls, replies };
}
