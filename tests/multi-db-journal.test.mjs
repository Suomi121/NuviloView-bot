import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStorage } from '../lib/storage/index.mjs';
import { createQuorumJournal } from '../lib/multi-db/journal.mjs';
import { createQuorumReconciler } from '../lib/multi-db/reconciler.mjs';
import { createCoordinator } from '../lib/multi-db/coordinator.mjs';
import { securityFixture, guild } from './helpers/quorum-fixture.mjs';

test('quorum history replays atomic SQLite Audit/Outbox after local failure; restart never duplicates', async t => {
  const f = await securityFixture(t);
  const storage = createLocalStorage({ databasePath: ':memory:' });
  t.after(() => storage.close());
  const journal = createQuorumJournal(storage);
  let broken = true;
  const coordinator = createCoordinator({ providers: f.providers, epoch: 'fixture-epoch', journal: state => {
    if (broken) throw new Error('SQLITE_CORRUPT');
    return journal(state);
  } });
  assert.equal((await coordinator.read(guild)).value.revision, 1);
  assert.equal(coordinator.diagnostics().journal, 'UNAVAILABLE');
  await f.change('level', 62);
  broken = false;
  const recovered = await coordinator.read(guild);
  assert.equal(recovered.value.data.policy.strength, 62);
  assert.equal(coordinator.diagnostics().journal, 'DURABLE');
  const outboxBefore = storage.outbox.getQueueSize();
  await coordinator.read(guild);
  assert.deepEqual(storage.outbox.getQueueSize(), outboxBefore);
  assert.equal(storage.security.getByEventId(`quorum:fixture-epoch:${guild}:2`).payload.checksum, recovered.checksum);
});

test('bounded Worker reconciliation repairs recovering voter and reports conflicts without deleting history', async t => {
  const f = await securityFixture(t); let clock = 0;
  f.faults.neon = true;
  await f.change('level', 48);
  f.faults.neon = false;
  const repair = createQuorumReconciler({ coordinator: f.coordinator, now: () => clock, intervalMs: 100 });
  await repair.processOnce();
  assert.equal(repair.status().state, 'CONSISTENT');
  assert.ok(f.dbs[0].prepare('SELECT checksum FROM mdb_acceptor WHERE slot=2').get().checksum);
  for (const db of f.dbs) db.exec("UPDATE mdb_acceptor SET checksum='damaged' WHERE slot=1");
  clock += 101; await repair.processOnce();
  assert.equal(repair.status().state, 'MANUAL_CONFLICT_REVIEW');
  assert.equal(f.dbs[0].prepare('SELECT count(*) n FROM mdb_acceptor WHERE accepted_ballot IS NOT NULL').get().n, 2);
});
