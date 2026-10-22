import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const incidentIdPattern = /^timeout-[a-f0-9]{40}$/;
export function evidenceComponents(incidentId) {
  if (!incidentIdPattern.test(incidentId)) throw new Error('INVALID_INCIDENT');
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nvsec:e:${incidentId}`).setLabel('検知データを表示').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`nvsec:r:${incidentId}`).setLabel('誤検知を報告').setStyle(ButtonStyle.Primary),
  )];
}
export function parseEvidenceAction(value) {
  const match = /^nvsec:([er]):(timeout-[a-f0-9]{40})$/.exec(value ?? '');
  return match ? { action: match[1], incidentId: match[2] } : null;
}
const json = item => typeof item?.toJSON === 'function' ? item.toJSON() : item;
// Ignore Discord-generated fields, but bind every visible application field and
// button to the exact message recorded by the successful delivery stage.
export function securityLogFingerprint(payload) {
  const embeds = (payload.embeds ?? []).map(json).map(e => ({
    title: e.title ?? null, description: e.description ?? null, color: e.color ?? null,
    fields: (e.fields ?? []).map(f => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
    footer: e.footer?.text ?? null,
  }));
  const components = (payload.components ?? []).map(json).map(row => ({ type: row.type,
    components: (row.components ?? []).map(json).map(b => ({ type: b.type, custom_id: b.custom_id,
      label: b.label, style: b.style, disabled: Boolean(b.disabled) })),
  }));
  return createHash('sha256').update(JSON.stringify({ embeds, components })).digest('hex');
}
