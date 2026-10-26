import { denied } from './coordinator.mjs';
const enabled=v=>['true','1','yes','on'].includes(String(v??'').toLowerCase());
export function validateApplicationConfiguration(env,{role='web'}={}) {
  if(!env.APPLICATION_DATA_MODE || env.APPLICATION_DATA_MODE==='legacy')return;
  if(env.APPLICATION_DATA_MODE!=='quorum'||env.SECURITY_COORDINATOR_MODE!=='quorum'||!/^\d{16,22}$/.test(env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID??''))denied('APP_CONFIGURATION');
  if(['web','worker'].includes(role)&&(!/^[a-f0-9]{64}$/.test(env.APPLICATION_DATA_ENCRYPTION_KEY??'')||!/^[a-zA-Z0-9_-]{1,64}$/.test(env.APPLICATION_DATA_ENCRYPTION_KEY_ID??'')))denied('APP_ENCRYPTION_REQUIRED');
  if(role==='worker'&&(!/^[a-f0-9]{32}$/.test(env.APPLICATION_PUBLISHER_ID??'')||!/^[a-f0-9]{32}$/.test(env.APPLICATION_SOURCE_EPOCH??'')))denied('APP_PUBLISHER_CONFIGURATION');
  if(['bot','worker'].includes(role)&&(!enabled(env.LOCAL_FIRST_ALL_GUILDS_ENABLED)||!enabled(env.EVENT_LOCAL_FIRST_ENABLED)))denied('APP_LOCAL_FIRST_REQUIRED');
  if(role==='bot'&&env.NUVILOVIEW_SINGLETON_AUTHORITY!=='quorum')denied('APP_RUNTIME_FENCE_REQUIRED');
}
