import 'server-only'
import {getSecurityCoordinator} from './web-runtime'
import {withWebReadRouter} from '@/lib/web-analytics-read'
import {readApplicationRuntime} from './application-runtime-read.mjs'
let pending: Promise<Awaited<ReturnType<typeof readApplicationRuntime>>> | null = null
export async function readApplicationRuntimeForWeb() {
  // Authorized diagnostic endpoints share only simultaneous observations,
  // never a time-based cache; this is not the execution ownership proof.
  if(pending)return pending
  const runtime=await getSecurityCoordinator(),controlId=process.env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID
  if(!runtime||!controlId)throw Object.assign(new Error('Runtime not configured'),{code:'APP_CONFIGURATION'})
  if(pending)return pending
  const operation=readApplicationRuntime({coordinator:runtime.coordinator,controlId,
    readProjection:()=>withWebReadRouter(router=>Promise.all([router.readRuntimeSnapshot(),router.readSyncStatusSnapshot()]))})
  pending=operation
  try{return await operation}finally{if(pending===operation)pending=null}
}
