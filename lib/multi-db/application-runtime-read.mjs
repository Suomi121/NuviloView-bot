import {evaluateProjectionBotHealth} from '../production-bot-monitor.mjs';
// Ownership is a non-expiring quorum grant, NOT a legacy PostgreSQL TTL lease.
// A heartbeat can describe this owner only if its actual instance/host match.
export async function readApplicationRuntime({coordinator,controlId,readProjection,now=Date.now()}) {
  const owner=await coordinator.scoped('runtime-owner').read(controlId);
  const [runtimeRead,syncRead]=await readProjection();
  const identity=owner.value.data.owner,payload=runtimeRead?.snapshot?.payload??{};
  const matched=Boolean(identity&&payload.botInstanceId===identity.instanceId&&payload.botHostId===identity.hostId);
  const heartbeat=Number(payload.botHeartbeatAt),validBeat=matched&&Number.isFinite(heartbeat)&&heartbeat>0&&heartbeat<=now+60000;
  const health=matched?evaluateProjectionBotHealth({runtimeRead,syncRead,at:now}):null;
  const state=!matched?'Unknown':health.available?(health.state==='Healthy'?'Healthy':'Warning'):'Critical';
  const diagnostic={state,heartbeatAgeSeconds:validBeat?Math.max(0,(now-heartbeat)/1000):null,
    incidents:state==='Healthy'?[]:[{code:!matched?'owner_heartbeat_unconfirmed':health.reason??'runtime_degraded',message:!matched?'Quorum所有者に一致するBot heartbeatは未確認です。':'Bot/Worker/同期の観測結果が正常ではありません。'}]};
  return {enabled:true,authority:'cloud-quorum',epoch:coordinator.epoch,dbNow:null,observedAt:new Date(now).toISOString(),
    lease:{serviceKey:'nuviloview-bot',ownerInstanceId:identity?.instanceId??null,hostId:identity?.hostId??null,fencingToken:owner.fencingToken,leaseExpiresAt:null,acquiredAt:null,renewedAt:null},diagnostic,
    heartbeats:validBeat?[{instanceId:identity.instanceId,hostId:identity.hostId,fencingToken:owner.fencingToken,platform:'UNKNOWN',startedAt:null,
      lastHeartbeatAt:new Date(heartbeat).toISOString(),status:String(payload.botStatus??'UNKNOWN'),leaseState:'Owned',appVersion:'UNKNOWN',
      commitSha:/^[a-f0-9]{7,40}$/.test(payload.botCommit??'')?payload.botCommit:null,guildCount:Number.isInteger(payload.botGuildCount)?payload.botGuildCount:null,stoppedAt:null}]:[],
    historyCoverage:'current_confirmed_owner_only',readMeta:runtimeRead?.metadata??null};
}
