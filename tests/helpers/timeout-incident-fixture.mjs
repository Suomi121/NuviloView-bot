import { createLocalStorage } from '../../lib/storage/index.mjs';
import { createSecurityAuditService } from '../../lib/security-local-first.mjs';
import { createTimeoutIncidentService } from '../../lib/timeout-incidents.mjs';
export const guildId='100000000000000001', userId='300000000000000001', channelId='400000000000000001', messageId='500000000000000001';
export function incidentFixture({databasePath=':memory:', wrapAudit=a=>a}={}) {
  const storage=createLocalStorage({databasePath});
  const audit=wrapAudit(createSecurityAuditService({storage}));
  const incidents=createTimeoutIncidentService({audit,now:()=>1790000000000,version:'0.2.0-rc.1',commit:'94284b1'});
  const input={guildId,userId,messageId,channelId,occurredAt:1790000000000,signals:['messages'],count:12,windowSeconds:5};
  return {storage,audit,incidents,input,begin:()=>incidents.begin(input)};
}
