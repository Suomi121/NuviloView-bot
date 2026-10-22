import { runSmoke } from './lib/security-evidence-smoke.mjs';
// No fallback to a Production token/env, no raw exception or request output.
runSmoke().catch(() => {
  console.error('Security evidence smoke stopped safely. Check isolated config, lock, Bot identity and permissions. No automatic retry.');
  process.exitCode = 1;
});
