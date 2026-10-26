// Finite header + body wait even if an adapter ignores AbortSignal.
export async function fetchJsonBounded(url,{fetcher=globalThis.fetch,timeoutMs=8000,signal,...init}={}) {
 const controller=new AbortController();let timer;
 const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
 try{return await Promise.race([(async()=>{
  const response=await fetcher(url,{...init,signal:combined});const body=await response.json();
  if(!response.ok)throw Object.assign(new Error('REQUEST_FAILED'),{code:body?.code??'DB_UNAVAILABLE',status:response.status,configurationState:body?.configurationState??'unavailable'});
  return body;
 })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('REQUEST_TIMEOUT'),{code:'READ_TIMEOUT'}));},timeoutMs);})]);}
 finally{clearTimeout(timer);}
}
