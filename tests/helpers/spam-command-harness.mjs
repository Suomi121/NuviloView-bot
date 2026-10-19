import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as policy from '../../lib/guild-spam-policy.mjs';
import * as consent from '../../lib/security-v2-consent.mjs';

// Execute the deployed handler and only its actual imports, without starting a Bot.
export function loadSpamCommand({ query = async () => { throw new Error('Unexpected SQL'); }, get = async () => ({ source: 'default', policy: null }) } = {}) {
  const source = readFileSync(new URL('../../discord-bot.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/lib\/guild-spam-policy\.mjs["']/g)][0][1];
  const bindings = Object.fromEntries(imports.split(',').map(s => s.trim()).filter(Boolean).map(name => [name, policy[name]]));
  const warnings = [];
  const invalidated = [];
  const context = vm.createContext({ ...bindings, ...consent, process: { env: {} }, sql: { query },
    guildSpamPolicyCache: { get, invalidate: id => invalidated.push(id) },
    PermissionFlagsBits: { Administrator: 'admin', ManageGuild: 'manage' },
    MessageFlags: { Ephemeral: 64 }, console: { warn: text => warnings.push(text) } });
  const code = source.slice(source.indexOf('const defaultSpamPolicyDatabaseFields ='), source.indexOf('const spamActionLocks ='));
  const result = vm.runInContext(code + '\n({run: handleSpamProtectionCommand, save: SAVE_SPAM_POLICY_COMMAND_SQL, defaults: defaultSpamPolicyDatabaseFields})', context);
  return { ...result, warnings, invalidated };
}

export function interaction(operation = 'status', { guild = '100000000000000001', permission = 'manage', value = 75, inGuild = true } = {}) {
  const replies = [];
  const acknowledgements = [], responseMethods = [];
  return { replies, acknowledgements, responseMethods, guildId: guild, user: { id: '100000000000000003' }, inGuild: () => inGuild,
    memberPermissions: { has: p => p === permission },
    options: { getSubcommand: () => operation, getInteger: () => value, getBoolean: () => value },
    async deferReply(payload) {
      if (this.deferred || this.replied) throw Object.assign(new Error('Already acknowledged'), { code: 40060 });
      acknowledgements.push(payload); responseMethods.push('defer'); this.deferred = true;
    },
    async editReply(payload) {
      if (!this.deferred && !this.replied) throw new Error('INTERACTION_NOT_REPLIED');
      responseMethods.push('edit'); this.replied = true; replies.push(payload);
    },
    async reply(payload) {
      if (this.deferred || this.replied) throw Object.assign(new Error('Already acknowledged'), { code: 40060 });
      responseMethods.push('reply'); this.replied = true; replies.push(payload);
    } };
}
