import { createLocalStorage } from '../../lib/storage/index.mjs';
import { createNewsCloudGuard } from '../../lib/news-cloud-guard.mjs';
import { createNewsService } from '../../lib/news-service.mjs';
import { getProviderPolicyDefinitions } from '../../lib/sync/providers/contract.mjs';
export const owner = '100000000000000001', other = '100000000000000002';
export const channel = '200000000000000001', message = '300000000000000001';
export const guilds = n => Array.from({length:n},(_,i)=>String(400000000000000000n+BigInt(i)));
export const target = guild => String(BigInt(guild)+100000000000000000n);
export function newsFixture(t, { databasePath=':memory:', ready=async()=>true, storageWrap=s=>s, storageNow=Date.now } = {}) {
  const db=createLocalStorage({ databasePath, now:storageNow, providerDefinitions:getProviderPolicyDefinitions({MULTI_DB_SYNC_ENABLED:'true',SYNC_SUPABASE_ENABLED:'true',SYNC_TURSO_ENABLED:'true',SYNC_NEON_ENABLED:'true'}) });
  t.after(()=>db.close());
  const storage=storageWrap(db), maps=new Map(), faults={};
  const providers=['neon','supabase','turso'].map(id=>{
    const records=new Map();maps.set(id,records);
    return {id,isEnabled:()=>true,getEventChecksums:async ids=>{
      if(faults[id])throw new Error('SECRET'); return new Map(ids.filter(k=>records.has(k)).map(k=>[k,records.get(k)]));
    },pushEvents:async items=>{
      if(faults[id])throw new Error('SECRET');
      for(const e of items){if(records.has(e.eventId)&&records.get(e.eventId)!==e.checksum)throw new Error('CONFLICT');records.set(e.eventId,e.checksum);}
      return {succeededEventIds:items.map(e=>e.eventId)};
    }};
  });
  const cloud=createNewsCloudGuard({registry:{list:()=>providers},timeoutMs:100});
  const allowed=new Set([owner]); let at=1792893600000;
  const options={storage,cloud,ready,isDeveloper:id=>allowed.has(id),now:()=>at};
  const service=createNewsService(options);
  const input=n=>({id:n.id,ownerId:owner,nonce:n.nonce,version:n.version,channelId:channel,messageId:message});
  async function draft(){const n=await service.create(owner);return service.bind(n.id,owner,channel,message);}
  const edit=n=>service.edit(input(n),{title:'ニュース',body:'合成ニュース本文',url:'https://example.com/news',color:'#5865f2'});
  async function queued(ids=guilds(1)){
    let n=edit(await draft());for(const g of ids)service.setDestination(owner,g,target(g));
    n=await service.prepare(input(n),ids);return service.confirm(input(n));
  }
  return {service,options,db,cloud,maps,faults,allowed,input,draft,edit,queued,clock:n=>{at+=n;}};
}
export async function drain(service,id,transport){for(let i=0;i<100;i++){if(service.get(id).state==='completed')return;await service.deliverOne(id,transport);}throw new Error('TEST_DRAIN_LIMIT');}
