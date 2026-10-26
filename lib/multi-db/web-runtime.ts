import 'server-only'
import { createSecurityCoordinatorRuntime } from './runtime.mjs'

let runtime: ReturnType<typeof createSecurityCoordinatorRuntime> | null = null
export function getSecurityCoordinator() {
  if (process.env.SECURITY_COORDINATOR_MODE !== 'quorum') return Promise.resolve(null)
  runtime ??= createSecurityCoordinatorRuntime(process.env).catch(error => { runtime = null; throw error })
  return runtime
}
