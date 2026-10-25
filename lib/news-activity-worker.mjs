import { parentPort,workerData } from 'node:worker_threads';
import { createLocalStorage } from './storage/index.mjs';
let storage;
try{
  storage=createLocalStorage({databasePath:workerData.databasePath,readOnly:true,writeEnabled:false,busyTimeoutMs:250});
  parentPort.on('message',({id,guildId,at})=>{
    try{parentPort.postMessage({id,result:storage.messageDomain.getChannelMessageActivity(guildId,{at})});}
    catch{parentPort.postMessage({id,result:null});}
  });
}catch{parentPort.postMessage({unavailable:true});parentPort.close();storage?.close();}
