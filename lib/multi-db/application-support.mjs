import { checksum,denied } from './coordinator.mjs';
// Claim BEFORE the external side effect. Ambiguous delivery is NEVER retried.
export async function submitApplicationSupport({store,controlId,requestId,actorId,form,send}) {
  if(!/^[a-f0-9]{32}$/.test(requestId??''))denied('APP_INPUT');
  const input={domain:'support',guildId:controlId,ownerId:`support:${requestId}`,actorId};
  let current=await store.read(input);const intent=checksum(form);
  if(current.data){if(current.data.intent!==intent)denied('APP_SUPPORT_CONFLICT');return{requestId,delivery:current.data.delivery==='CLAIMED'?'UNKNOWN':current.data.delivery,replayed:true};}
  // Saving CLAIMED before invoking the provider conservatively survives a
  // crash between the HTTP success and the receipt write.
  const data={form,intent,delivery:'CLAIMED',safeCode:null};
  current=await store.write({...input,requestId:`support:${requestId}:claim`,expectedEpoch:current.epoch,expectedRevision:0,expectedChecksum:'GENESIS',acknowledgeUnconfirmed:true,data});
  let delivery='UNKNOWN',safeCode='DELIVERY_OUTCOME_UNKNOWN';
  try{const result=await send();delivery=result===true?'SENT':'FAILED';safeCode=result===true?null:'DELIVERY_REJECTED';}catch{/* Never serialize provider exceptions or request secrets. */}
  try{await store.write({...input,requestId:`support:${requestId}:result`,expectedEpoch:current.epoch,expectedRevision:current.revision,expectedChecksum:current.checksum,data:{...data,delivery,safeCode}});}
  catch{return{requestId,delivery:'UNKNOWN',receiptStored:false};}
  return{requestId,delivery,receiptStored:true};
}
