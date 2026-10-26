import { MessagePayload, REST, Routes } from 'discord.js';

// discord.js normally retries ambiguous network/5xx failures three times.
// Reports must NOT do that. Isolate this transport instead of changing the
// Bot-wide REST settings used by moderation, interactions and the Worker.
export const securityReportRestOptions = Object.freeze({
  version: '10', retries: 0, timeout: 10_000, rejectOnRateLimit: () => true,
});
export function createSecurityReportDelivery({ client, rest = new REST(securityReportRestOptions) }) {
  return async (channel, payload) => {
    if (!client.token) throw new Error('REPORT_TRANSPORT_UNAVAILABLE');
    const message = MessagePayload.create(channel, payload).resolveBody();
    const { body, files } = await message.resolveFiles();
    const response = await rest.setToken(client.token).post(Routes.channelMessages(channel.id), {
      body, files, signal: AbortSignal.timeout(10_000),
    });
    return { id: response.id, channelId: response.channel_id, guildId: response.guild_id ?? channel.guildId };
  };
}
