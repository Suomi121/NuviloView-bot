import { readFileSync } from 'node:fs';
import { checksum, denied } from '../lib/multi-db/coordinator.mjs';
import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
import { validateApplicationConfiguration } from '../lib/multi-db/application-config.mjs';
let runtime;
try {
  const path = process.argv.find(a => a.startsWith('--plan='))?.slice(7);
  const plan = JSON.parse(readFileSync(path,'utf8'));
  if (plan.version !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(plan.epoch ?? '') || !/^[a-f0-9]{64}$/.test(plan.recoveryPlanChecksum ?? '') || !/^\d{16,22}$/.test(plan.controlId ?? '') || !/^[a-f0-9]{32}$/.test(plan.publisherId ?? '') || !/^[a-f0-9]{32}$/.test(plan.sourceEpoch ?? '') || plan.legacyWritersFenced !== true || plan.localSourceReviewed !== true) denied('APP_INITIALIZATION_PLAN');
  const hash = checksum(plan);
  if (!process.argv.includes('--execute-approved')) console.log(JSON.stringify({ mode: 'PLAN_ONLY', checksum: hash, mutates: false, epoch: plan.epoch, sourceState: 'new-epoch-rebuild' }));
  else {
    if (process.env.APPLICATION_INITIALIZATION_APPROVED !== hash || process.env.SECURITY_COORDINATOR_EPOCH !== plan.epoch) denied('APP_INITIALIZATION_APPROVAL');
    validateApplicationConfiguration(process.env,{role:'worker'});
    runtime = await createSecurityCoordinatorRuntime(process.env);
    if (!runtime) denied('APP_CONFIGURATION');
    const manifest = await runtime.coordinator.scoped('recovery').read(plan.controlId);
    if (manifest.value.data.planChecksum !== plan.recoveryPlanChecksum) denied('APP_RECOVERY_CONFLICT');
    const c = runtime.coordinator.scoped('application-publisher');
    let old; try { old = await c.read(plan.controlId); } catch (e) { if (e.code !== 'MDB_NOT_ENROLLED') throw e; }
    const data = { publisherId: plan.publisherId, sourceEpoch: plan.sourceEpoch, planChecksum: hash };
    if (old && checksum(old.value.data) !== checksum(data)) denied('APP_PUBLISHER_CONFLICT');
    if (!old) await c.update({ guildId: plan.controlId, actorId: 'approved-application-transfer', requestId: `init:${hash.slice(0,32)}`, expectedRevision: 0, expectedChecksum: 'GENESIS', action: 'application:initialize', data });
    console.log(JSON.stringify({ mode: 'INITIALIZED', epoch: plan.epoch, checksum: hash, legacyDataChanged: false }));
  }
} catch (error) { console.error(JSON.stringify({ state: 'STOPPED', code: /^(APP|MDB)_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'APP_INITIALIZATION_UNAVAILABLE' })); process.exitCode = 1; }
finally { await runtime?.close(); }
