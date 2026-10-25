import { createReadStream,writeFileSync,existsSync,statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
let client;
try{
 const backup=arg('backup'),certificate=arg('certificate'),url=new URL(process.env.TEST_QUORUM_RESTORE_DATABASE_URL??'');
 if(!isAbsolute(backup??'')||!isAbsolute(certificate??'')||!existsSync(backup)||!statSync(backup).isFile()||existsSync(certificate)||
  !['127.0.0.1','localhost'].includes(url.hostname)||!/^\/nuviloview_[a-z0-9_]*restore_test$/.test(url.pathname)||process.env.TEST_QUORUM_RESTORE_ISOLATED!=='1')throw Error('RESTORE_ISOLATION_REQUIRED');
 const hash=createHash('sha256');for await(const bytes of createReadStream(backup))hash.update(bytes);const backupChecksum=hash.digest('hex');
 if(backupChecksum!==arg('checksum'))throw Error('BACKUP_CHECKSUM_MISMATCH');
 client=new pg.Client({connectionString:url.href});await client.connect();
 const count=Number((await client.query("SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')")).rows[0].n);
 if(count!==0)throw Error('RESTORE_TARGET_NOT_EMPTY');
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(arg('pg-restore')??'pg_restore',['--exit-on-error','--no-owner','--no-privileges','--dbname',url.pathname.slice(1),backup],
   {windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)}});
  child.stderr.resume();child.on('error',reject);child.on('exit',resolve);
 });
 if(code!==0)throw Error('RESTORE_FAILED');
 const counts={};
 for(const table of ['guild_spam_policy','guild_security_v2_enrollment','guild_security_v2_auto','guild_security_operator','guild_security_log']){
  counts[table]=Number((await client.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
 }
 writeFileSync(certificate,JSON.stringify({version:1,backupPath:backup,backupChecksum,restoreVerified:true,verifiedAt:new Date().toISOString(),counts},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({result:'RESTORE_VERIFIED',counts,backupChecksum,productionTouched:false}));
}catch(e){console.error(JSON.stringify({result:'STOPPED',code:/^[A-Z_]+$/.test(e?.message??'')?e.message:'RESTORE_UNAVAILABLE'}));process.exitCode=1;}
finally{await client?.end();}
