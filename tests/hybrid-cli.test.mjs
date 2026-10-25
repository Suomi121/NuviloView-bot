import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateTransferPlan } from '../lib/multi-db/transfer.mjs';
import { initialSecuritySnapshot } from '../lib/multi-db/security-service.mjs';
import { checksum } from '../lib/multi-db/coordinator.mjs';
import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
test('transfer plan defaults offline/read-only; executable route needs exact approval and real backup evidence',t=>{
 const dir=mkdtempSync(join(tmpdir(),'nv-hybrid-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const snapshot=initialSecuritySnapshot(),plan={version:1,epoch:'isolated-test',guilds:[{guildId:'100000000000000001',snapshot,checksum:checksum(snapshot)}]};
 const path=join(dir,'plan.json');writeFileSync(path,JSON.stringify(plan),{mode:0o600});
 const run=(extra=[])=>spawnSync(process.execPath,['scripts/transfer-security-quorum.mjs',`--plan=${path}`,...extra],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,DATABASE_URL:'invalid-not-used'}});
 const p=run();assert.equal(p.status,0);assert.equal(JSON.parse(p.stdout).mode,'PLAN_ONLY');assert.doesNotMatch(p.stdout,/invalid-not-used/);
 const execute=run(['--execute-reviewed-plan']);assert.notEqual(execute.status,0);assert.match(execute.stderr,/MDB_TRANSFER_APPROVAL_REQUIRED/);
 assert.throws(()=>validateTransferPlan({...plan,runtimeApplicationId:'bad'}),{code:'MDB_TRANSFER_PLAN'});
});
test('malformed secret-bearing database URL is never included in runtime diagnostics',async()=>{
 await assert.rejects(createSecurityCoordinatorRuntime({SECURITY_COORDINATOR_MODE:'quorum',SECURITY_COORDINATOR_SUPABASE_URL:'private-secret-not-a-url'}),e=>e.message==='MDB_DATABASE_IDENTITY'&&!String(e).includes('private-secret'));
});
