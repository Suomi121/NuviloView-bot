import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {validateApplicationConfiguration} from '../lib/multi-db/application-config.mjs';
import {auditDatabaseAccess} from '../scripts/audit-database-access.mjs';
test('application cutover rejects missing encryption, Local First, publisher and runtime fencing configuration',()=>{
 const base={APPLICATION_DATA_MODE:'quorum',SECURITY_COORDINATOR_MODE:'quorum',SECURITY_COORDINATOR_RECOVERY_CONTROL_ID:'100000000000000009',APPLICATION_DATA_ENCRYPTION_KEY:'7'.repeat(64),APPLICATION_DATA_ENCRYPTION_KEY_ID:'isolated-key',APPLICATION_PUBLISHER_ID:'a'.repeat(32),APPLICATION_SOURCE_EPOCH:'b'.repeat(32),LOCAL_FIRST_ALL_GUILDS_ENABLED:'true',EVENT_LOCAL_FIRST_ENABLED:'true',NUVILOVIEW_SINGLETON_AUTHORITY:'quorum'};
 for(const role of ['bot','worker','web'])assert.doesNotThrow(()=>validateApplicationConfiguration(base,{role}));
 assert.throws(()=>validateApplicationConfiguration({...base,APPLICATION_DATA_ENCRYPTION_KEY:''}),{code:'APP_ENCRYPTION_REQUIRED'});
 assert.throws(()=>validateApplicationConfiguration({...base,APPLICATION_PUBLISHER_ID:''},{role:'worker'}),{code:'APP_PUBLISHER_CONFIGURATION'});
 assert.throws(()=>validateApplicationConfiguration({...base,LOCAL_FIRST_ALL_GUILDS_ENABLED:'false'},{role:'worker'}),{code:'APP_LOCAL_FIRST_REQUIRED'});
 assert.throws(()=>validateApplicationConfiguration({...base,NUVILOVIEW_SINGLETON_AUTHORITY:'neon'},{role:'bot'}),{code:'APP_RUNTIME_FENCE_REQUIRED'});
 assert.throws(()=>validateApplicationConfiguration({...base,APPLICATION_DATA_MODE:'typo'}),{code:'APP_CONFIGURATION'});
});
test('actual Bot pollers cannot consume old Neon import/reset jobs in the new epoch',async()=>{
 const source=fs.readFileSync(new URL('../discord-bot.mjs',import.meta.url),'utf8');
 for(const [name,next] of [['pollHistoryImportJobs','let guildResetRequestPolling'],['pollGuildResetRequests','function hasHumanVoiceActivity']]){
  const body=source.slice(source.indexOf(`async function ${name}`),source.indexOf(next,source.indexOf(`async function ${name}`)));
  const run=vm.runInNewContext(body+`\n${name}`,{process:{env:{APPLICATION_DATA_MODE:'quorum'}}});
  // No repositories, configuration or DB clients are injected: any attempt to
  // reach old code throws. The actual new-mode entry must return first.
  await run();
 }
 const purge=source.slice(source.indexOf('async function purgeGuildData'),source.indexOf('async function leaveBlockedGuild'));
 const run=vm.runInNewContext(purge+'\npurgeGuildData',{process:{env:{APPLICATION_DATA_MODE:'quorum'}}});
 await assert.rejects(run('100000000000000001'),/APP_ALL_DATABASE_DELETION_UNMIGRATED/);
 assert.ok(source.includes("interaction.commandName.startsWith('dev-reset-')"));
});
test('full DB inventory covers direct Neon callers and flags remaining work rather than declaring complete availability',()=>{
 const result=auditDatabaseAccess(fileURLToPath(new URL('..',import.meta.url)));
 assert.ok(result.callSites>500);assert.ok(result.rows.some(r=>r.path==='discord-bot.mjs'&&r.tables.includes('reaction_role_rule')));
 assert.ok(result.rows.some(r=>r.classification==='PENDING_DESTRUCTIVE_JOB_PROTOCOL'));
 assert.equal(result.rows.filter(r=>r.classification==='REVIEW_REQUIRED').length,0);
});
test('unmigrated destructive paths and private search cannot silently fall back to stale Neon after cutover',()=>{
 for(const [path,marker] of [['lib/guild-reset-api.ts','FEATURE_DISABLED'],['app/api/history-import/route.ts','APP_IMPORT_UNMIGRATED'],['app/api/messages/search/route.ts','APP_SEARCH_UNMIGRATED']]){
  const source=fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');assert.ok(source.includes("APPLICATION_DATA_MODE === 'quorum'"));assert.ok(source.includes(marker));
 }
});
