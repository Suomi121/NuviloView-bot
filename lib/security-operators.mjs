import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';

const snowflake = /^\d{16,22}$/;
const resultRows = result => Array.isArray(result) ? result : result?.rows ?? [];
export const operatorRoleCommand = new SlashCommandBuilder().setName('adsetroll')
  .setDescription('NuviloViewの閲覧・報告用運営ロールを管理します').setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub.setName('add').setDescription('運営ロールに登録します')
    .addRoleOption(option => option.setName('role').setDescription('登録するロール').setRequired(true)))
  .addSubcommand(sub => sub.setName('remove').setDescription('運営ロールの登録を解除します')
    .addRoleOption(option => option.setName('role').setDescription('解除するロール').setRequired(true)))
  .addSubcommand(sub => sub.setName('list').setDescription('登録済み運営ロールを確認します'))
  .addSubcommand(sub => sub.setName('status').setDescription('運営ロールの権限範囲を確認します')).toJSON();

// Never authorize from the Interaction's stale member/role snapshot.
export async function freshSecurityMember(interaction) {
  if (!interaction.inGuild?.() || !interaction.guild || !snowflake.test(interaction.guildId)) throw new Error('GUILD_REQUIRED');
  const guild = await interaction.guild.fetch();
  if (guild.id !== interaction.guildId) throw new Error('GUILD_MISMATCH');
  const roles = await guild.roles.fetch();
  if (!roles || typeof roles.get !== 'function') throw new Error('ROLES_UNAVAILABLE');
  const member = await guild.members.fetch({ user: interaction.user.id, force: true });
  if (!member || member.guild.id !== guild.id || member.id !== interaction.user.id) throw new Error('MEMBER_MISMATCH');
  const administrator = member.id === guild.ownerId || [...roles.values()].some(role =>
    (role.id === guild.id || member.roles.cache.has(role.id)) && role.permissions?.has(PermissionFlagsBits.Administrator) === true);
  return { guild, member, administrator, roles };
}

export async function readOperatorRoles(query, guildId) {
  if (!snowflake.test(guildId)) throw new Error('INVALID_GUILD');
  const row = resultRows(await query('SELECT role_ids FROM guild_security_operator WHERE guild_id=$1', [guildId]))[0];
  if (!row) return [];
  if (!Array.isArray(row.role_ids) || row.role_ids.length > 20 || row.role_ids.some(value => !snowflake.test(value))) throw new Error('INVALID_OPERATOR_STATE');
  return row.role_ids;
}

export async function authorizeSecurityOperator(interaction, query) {
  try {
    const current = await freshSecurityMember(interaction);
    if (current.administrator) return current;
    const roles = await readOperatorRoles(query, current.guild.id);
    if (roles.some(roleId => roleId !== current.guild.id && current.roles.has(roleId)
      && !current.roles.get(roleId).managed && !current.roles.get(roleId).tags
      && current.member.roles.cache.has(roleId))) return current;
  } catch { /* Missing metadata/DB/Discord always denies delegated privileges. */ }
  return null;
}

export const MUTATE_OPERATOR_ROLE_SQL = `
 WITH changed AS (
   INSERT INTO guild_security_operator (guild_id, role_ids)
   VALUES ($1::text, CASE WHEN $3::boolean THEN ARRAY[$2::text] ELSE ARRAY[]::text[] END)
   ON CONFLICT (guild_id) DO UPDATE SET role_ids = CASE WHEN $3::boolean
     THEN ARRAY(SELECT DISTINCT unnest(guild_security_operator.role_ids || ARRAY[$2::text]))
     ELSE array_remove(guild_security_operator.role_ids, $2::text) END,
     revision = guild_security_operator.revision + 1, updated_at=now()
   RETURNING guild_id, role_ids, revision
 ), audited AS (
   INSERT INTO guild_security_operator_audit (guild_id, actor_id, role_id, operation, revision)
   SELECT guild_id, $4::text, $2::text, CASE WHEN $3::boolean THEN 'add' ELSE 'remove' END, revision FROM changed
   RETURNING id
 ) SELECT role_ids FROM changed CROSS JOIN audited`;

export function createInteractionLimiter({ now = () => Date.now(), intervalMs = 5_000, maxEntries = 5_000 } = {}) {
  const entries = new Map();
  return key => {
    const at = now();
    for (const [id, until] of entries) if (until <= at) entries.delete(id);
    if (entries.has(key) || entries.size >= maxEntries) return false;
    entries.set(key, at + intervalMs); return true;
  };
}

export function createOperatorRoleHandler({ query, allow = createInteractionLimiter() }) {
  return async interaction => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    try {
      if (!allow(`${interaction.guildId}:${interaction.user.id}`)) return await reply('少し待ってからもう一度試してね。');
      const { guild, member, administrator } = await freshSecurityMember(interaction);
      if (!administrator) return await reply('この設定を変更・確認できるのはサーバー所有者かAdministratorだけだよ。');
      const operation = interaction.options.getSubcommand();
      if (['list', 'status'].includes(operation)) {
        const roles = await readOperatorRoles(query, guild.id);
        return await reply(`運営ロール: ${roles.length ? roles.map(id => guild.roles.cache.has(id) ? `<@&${id}>` : `${id}（削除済み・権限なし）`).join('、') : '未登録'}\n閲覧・誤検知報告専用です。設定変更や処罰権限は付与しません。`);
      }
      if (!['add', 'remove'].includes(operation)) return await reply('その操作は利用できません。');
      const selected = interaction.options.getRole('role', true);
      const role = guild.roles.cache.get(selected.id);
      if (!snowflake.test(selected.id) || !role || role.guild.id !== guild.id || role.id === guild.id || role.managed || role.tags) return await reply('このロールは登録できません。通常のサーバーロールを選んでね。');
      const bot = await guild.members.fetchMe({ force: true });
      if (operation === 'add' && (bot.roles.highest.comparePositionTo(role) <= 0 || (member.id !== guild.ownerId && member.roles.highest.comparePositionTo(role) <= 0))) return await reply('管理できる範囲のロールを選んでね。');
      const rows = resultRows(await query(MUTATE_OPERATOR_ROLE_SQL, [guild.id, role.id, operation === 'add', member.id]));
      if (rows.length !== 1) throw new Error('SAVE_FAILED');
      return await reply(operation === 'add' ? '運営ロールに登録したよ！' : '運営ロールの登録を解除したよ！');
    } catch { return await reply('権限または設定を確認できませんでした。設定は成功扱いにしていません。少し待ってから再確認してね。'); }
  };
}
