import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { freshSecurityMember } from '../security-operators.mjs';
import { spamProtectionLevel } from '../guild-spam-policy.mjs';

export async function handleQuorumSpamCommand(interaction, security) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
  try {
    const authorize = async () => {
      const { member, administrator } = await freshSecurityMember(interaction);
      return administrator || member.permissions.has(PermissionFlagsBits.ManageGuild);
    };
    if (!await authorize()) return reply('この操作はサーバー管理者のみ利用できます。');
    const state = await security.read(interaction.guildId);
    const operation = interaction.options.getSubcommand();
    const auto = interaction.options.getSubcommandGroup?.(false) === 'auto';
    let result = state;
    if (operation !== 'status') {
      const value = operation === 'level' ? interaction.options.getInteger('strength', true)
        : ['messages', 'duplicate', 'mentions', 'links', 'cross-channel'].includes(operation)
          ? interaction.options.getBoolean('enabled', true) : null;
      result = await security.change({ guildId: interaction.guildId, actorId: interaction.user.id,
        requestId: interaction.id, expectedRevision: state.value.revision, expectedChecksum: state.checksum,
        operation: auto ? `auto:${operation}` : operation, value, authorize });
    }
    const { data, revision, epoch } = result.value;
    return reply(`Spam Protection: ${data.policy.enabled ? 'ON' : 'OFF'}\nStrength: ${data.policy.strength ?? 'Custom'} / 100\nLevel: ${data.policy.mode === 'CUSTOM' ? 'Custom' : spamProtectionLevel(data.policy.strength)}\nAuto Timeout: ${data.autoTimeout ? 'ON' : 'OFF'}\nEmergency Stop: ${data.emergencyStop || process.env.SECURITY_V2_AUTO_EXECUTION !== 'enabled' ? 'ON' : 'OFF'}\nAuthority: Cloud Quorum\nEpoch: ${epoch}\nRevision: ${revision}`);
  } catch (error) {
    return reply(error?.code === 'MDB_REVISION_CONFLICT'
      ? 'ほかの操作で設定が更新されました。最新状態を確認してから再試行してください。'
      : 'DBの合意または権限を確認できません。保存成功とは扱っていません。再読込で状態を確認してください。');
  }
}
