import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, REST } from 'discord.js';
import { createSecurityReportDelivery, securityReportRestOptions } from '../lib/security-report-delivery.mjs';

for (const responseStatus of [200, 403, 429, 503]) test(`real SDK multipart serialization, HTTP ${responseStatus}, no ambiguous REST retry (loopback only)`, async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let length = 0; for await (const chunk of req) length += chunk.length;
    received.push({ method: req.method, path: req.url, length });
    res.writeHead(responseStatus, { 'Content-Type': 'application/json', ...(responseStatus === 429 ? { 'Retry-After': '0.01' } : {}) });
    res.end(JSON.stringify(responseStatus === 200
      ? { id: '500000000000000009', channel_id: '400000000000000009' }
      : { code: responseStatus === 429 ? 0 : 50013, message: 'isolated fixture rejection', retry_after: 0.01 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ intents: [] }); client.token = 'isolated-mock-token';
  const rest = new REST({ ...securityReportRestOptions, api: `http://127.0.0.1:${server.address().port}` });
  try {
    const channel = { id: '400000000000000009', guildId: '100000000000000009', client };
    const send = createSecurityReportDelivery({ client, rest });
    const payload = { content: '誤検知の疑いがある報告', files: [{ attachment: Buffer.from('UTF-8 の検知データ'), name: 'isolated-report.txt' }],
      nonce: '123456', enforceNonce: true, allowedMentions: { parse: [] } };
    if (responseStatus === 200) assert.deepEqual(await send(channel, payload), {
      id: '500000000000000009', channelId: channel.id, guildId: channel.guildId,
    });
    else await assert.rejects(send(channel, payload));
    assert.equal(received.length, 1); assert.equal(received[0].method, 'POST');
    assert.equal(received[0].path, `/v10/channels/${channel.id}/messages`); assert.ok(received[0].length < 16 * 1024);
    assert.equal(rest.options.retries, 0); assert.equal(rest.options.timeout, 10_000);
    assert.equal(client.rest.options.retries, 3, 'global Bot REST behavior is not changed');
  } finally {
    rest.clearHashSweeper(); rest.clearHandlerSweeper(); await client.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
