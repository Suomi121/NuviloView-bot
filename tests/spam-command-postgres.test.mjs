import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parseGuildSpamPolicyRow } from '../lib/guild-spam-policy.mjs';
import { loadSpamCommand, interaction } from './helpers/spam-command-harness.mjs';

test('actual command SQL: 42P08 regression, persistence, reset, audit and Guild isolation', { skip: !process.env.TEST_SPAM_DATABASE_URL }, async () => {
  const url = new URL(process.env.TEST_SPAM_DATABASE_URL);
  assert.equal(process.env.TEST_SPAM_ISOLATED, '1');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/nuviloview_spam_test');
  const client = new pg.Client({ connectionString: url.href }); await client.connect();
  try {
    assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0);
    for (const name of ['20260930-guild-spam-policy', '20261001-guild-spam-protection-controls']) {
      await client.query(readFileSync(new URL(`../scripts/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    const h = loadSpamCommand({ query: (q, p) => client.query(q, p), get: async guild => {
      const row = (await client.query('SELECT * FROM guild_spam_policy WHERE guild_id=$1', [guild])).rows[0];
      return { source: row ? 'guild' : 'default', policy: parseGuildSpamPolicyRow(row ?? null) };
    } });
    const guildA = '100000000000000001', guildB = '100000000000000002';
    const original = h.save.replace('$4::text', '$4');
    for (const actor of ['100000000000000003', null]) {
      await assert.rejects(client.query(original, [guildA, JSON.stringify(h.defaults), '{}', actor]), e => e.code === '42P08');
    }
    for (const [guild, value] of [[guildB, 25], [guildA, 75], [guildA, 33]]) {
      const i = interaction('level', { guild, value }); await h.run(i);
      assert.equal(h.warnings.length, 0); assert.match(i.replies[0].content, /Spam Protection/);
      const row = (await client.query('SELECT * FROM guild_spam_policy WHERE guild_id=$1', [guild])).rows[0];
      assert.equal(row.strength, value);
      const status = interaction('status', { guild }); await h.run(status);
      assert.match(status.replies[0].content, new RegExp(`${value} / 100`));
    }
    const beforeB = (await client.query('SELECT to_jsonb(p) AS value FROM guild_spam_policy p WHERE guild_id=$1', [guildB])).rows[0].value;
    const deny = interaction('reset', { guild: guildB, permission: 'none' }); await h.run(deny);
    assert.match(deny.replies[0].content, /管理者/);
    const reset = interaction('reset', { guild: guildA }); await h.run(reset);
    assert.equal(h.warnings.length, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM guild_spam_policy WHERE guild_id=$1', [guildA])).rows[0].n, 0);
    assert.deepEqual((await client.query('SELECT to_jsonb(p) AS value FROM guild_spam_policy p WHERE guild_id=$1', [guildB])).rows[0].value, beforeB);
    const audit = (await client.query('SELECT * FROM guild_spam_policy_audit WHERE guild_id=$1 ORDER BY id', [guildA])).rows;
    assert.equal(audit.length, 3); assert.equal(audit[2].new_preset, 'DEFAULT');
    assert.ok(audit[2].changed_fields.includes('reset'));
    await h.run(interaction('reset', { guild: guildA }));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM guild_spam_policy_audit WHERE guild_id=$1', [guildA])).rows[0].n, 3);
    const status = interaction('status', { guild: guildA }); await h.run(status);
    assert.match(status.replies[0].content, /legacy\/default/);
  } finally { await client.end(); }
});
