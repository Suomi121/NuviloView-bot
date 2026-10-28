import 'server-only'
import {getSecurityCoordinator} from './web-runtime'
import {createGuildAccess} from './guild-access.mjs'
import {createApplicationStore} from './application-store.mjs'
export async function getApplicationGuildAccess() {
  const runtime = await getSecurityCoordinator()
  if (!runtime) throw Object.assign(new Error('Guild access unavailable'), {code:'APP_CONFIGURATION'})
  return createGuildAccess({coordinator:runtime.coordinator})
}
export async function getDeveloperGuildRegistry(guildIds:string[]) {
  const runtime=await getSecurityCoordinator()
  if(!runtime)throw Object.assign(new Error('Guild registry unavailable'),{code:'APP_CONFIGURATION'})
  const store=createApplicationStore({...runtime,authorize:async({domain,guildId,operation}:{domain:string;guildId:string;operation:string})=>
    domain==='guild-registry'&&operation==='read'&&guildIds.includes(guildId)})
  return new Map(await Promise.all(guildIds.map(async guildId=>[guildId,(await store.read({domain:'guild-registry',guildId,actorId:'developer-registry-reader'})).data] as const)))
}
