import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@tursodatabase/serverless/compat';

// Real locked Turso HTTP SDK over a localhost Hrana transport and real SQLite.
// This does NOT certify hosted Turso durability/leader routing/replica semantics.
export async function isolatedTursoHttp(t) {
  const db = new DatabaseSync(':memory:');
  const encode = v => v === null ? { type: 'null' } : typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) };
  let offline = false;
  const server = createServer(async (req, res) => {
    try {
      if (offline) { res.writeHead(503).end(); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (req.url === '/v3/pipeline') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ baton: null, base_url: null, results: (request.requests ?? []).map(r => ({ type: 'ok', response: r.type === 'get_autocommit' ? { type: 'get_autocommit', is_autocommit: true } : { type: 'close' } })) }));
        return;
      }
      if (req.url !== '/v3/cursor') { res.writeHead(404).end(); return; }
      const entries = [{ baton: null, base_url: null }];
      for (const [step, item] of request.batch.steps.entries()) {
        const stmt = db.prepare(item.stmt.sql);
        const args = (item.stmt.args ?? []).map(v => v.type === 'null' ? null : v.type === 'integer' ? Number(v.value) : v.value);
        const cols = stmt.columns().map(c => ({ name: c.name, decltype: c.type ?? 'TEXT' }));
        const rows = stmt.all(...args);
        entries.push({ type: 'step_begin', step, cols });
        for (const row of rows) entries.push({ type: 'row', row: cols.map(c => encode(row[c.name])) });
        entries.push({ type: 'step_end', affected_row_count: 0, last_insert_rowid: null });
      }
      res.setHeader('Content-Type', 'text/plain'); res.end(entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    } catch { res.writeHead(500).end(JSON.stringify({ message: 'ISOLATED_SQL_FAILURE' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  return { db, client, setOffline: value => { offline = value; } };
}
