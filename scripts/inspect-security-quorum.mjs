import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
const guildId = process.argv.find(arg => arg.startsWith('--guild='))?.slice(8);
if (!/^\d{16,22}$/.test(guildId ?? '')) throw new Error('Usage: --guild=<Guild ID> [--repair]');
const runtime = await createSecurityCoordinatorRuntime();
if (!runtime) throw new Error('MDB_NOT_CONFIGURED');
try {
  if (process.argv.includes('--repair')) {
    const result = await runtime.security.read(guildId);
    console.log(JSON.stringify({ repaired: true, epoch: result.value.epoch, revision: result.value.revision,
      checksum: result.checksum, diagnostics: runtime.coordinator.diagnostics() }));
  } else {
    console.log(JSON.stringify({ observed: await runtime.coordinator.inspect(guildId), diagnostics: runtime.coordinator.diagnostics() }));
  }
} catch (error) {
  console.error(JSON.stringify({ result: 'NOT_CONFIRMED', code: /^MDB_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'MDB_UNAVAILABLE' }));
  process.exitCode = 1;
} finally { await runtime.close(); }
