import { Worker } from 'node:worker_threads';

// Read-only aggregation off the Discord event loop. This is NOT the Sync
// Worker; it cannot write SQLite, access cloud credentials, or deliver messages.
export function createNewsActivityReader(storage,{timeoutMs=2000,workerFactory=options=>new Worker(new URL('./news-activity-worker.mjs',import.meta.url),options)}={}){
  const databasePath=storage.health?.getDatabasePath?.();
  let worker=null,sequence=0,stopped=false,blocked=false,cooldownUntil=0;
  const pending=new Map();
  const settle=(id,result)=>{const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.resolve(result);}};
  const fail=()=>{
    for(const id of [...pending.keys()])settle(id,null);
    blocked=true;cooldownUntil=Date.now()+60000;
    const old=worker;worker=null;
    Promise.resolve(old?.terminate()).catch(()=>{}).finally(()=>{blocked=false;});
  };
  function start(){
    worker=workerFactory({workerData:{databasePath},env:{}});const active=worker;
    active.on('message',message=>{if(active!==worker)return;if(message.unavailable)fail();else settle(message.id,message.result);});
    active.on('error',()=>{if(active===worker)fail();});
    active.on('exit',()=>{if(active===worker)fail();});
  }
  return{
    async read(guildId,{at}){
      if(stopped||blocked||Date.now()<cooldownUntil||pending.size>=3||!databasePath)return null;
      if(databasePath===':memory:')return storage.messageDomain.getChannelMessageActivity(guildId,{at});
      if(!worker){try{start();}catch{fail();return null;}}
      return new Promise(resolve=>{
        const id=++sequence,timer=setTimeout(fail,timeoutMs);pending.set(id,{resolve,timer});
        try{worker.postMessage({id,guildId,at});}catch{fail();}
      });
    },
    async close(){stopped=true;for(const id of [...pending.keys()])settle(id,null);const old=worker;worker=null;await old?.terminate();},
  };
}
