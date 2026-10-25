import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './multi-db-coordinator.test.mjs';
import { checksum } from '../lib/multi-db/coordinator.mjs';
test('membership initializer is explicit, all-three verified, resumable but never changes old epoch',async t=>{
 const f=fixture(t);for(const db of f.dbs)db.prepare('DELETE FROM mdb_membership').run();
 await assert.rejects(f.c.initializeMembership('unapproved'),{code:'MDB_MEMBERSHIP_APPROVAL_REQUIRED'});
 f.faults.neon='offline';await assert.rejects(f.c.initializeMembership(checksum(f.c.membership)),{code:'MDB_BOOTSTRAP_INCOMPLETE'});
 f.faults.neon=null;assert.equal((await f.c.initializeMembership(checksum(f.c.membership))).verifiedVoters,3);
 f.dbs[0].prepare("UPDATE mdb_membership SET membership='old-epoch'").run();
 await assert.rejects(f.c.initializeMembership(checksum(f.c.membership)),{code:'MDB_BOOTSTRAP_INCOMPLETE'});
 assert.equal(f.dbs[0].prepare('SELECT membership FROM mdb_membership').get().membership,'old-epoch');
});
