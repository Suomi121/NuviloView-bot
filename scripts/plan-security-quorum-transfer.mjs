import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { snapshotLegacy,validateTransferPlan } from '../lib/multi-db/transfer.mjs';
import { canonical,checksum } from '../lib/multi-db/coordinator.mjs';
const option=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
let client;
try{
 const ids=option('guilds')?.split(','),out=option('out'),epoch=option('epoch');
 if(!ids?.length||!out||!isAbsolute(out)||!/^[a-zA-Z0-9_-]{1,64}$/.test(epoch??''))throw Error('MDB_TRANSFER_ARGUMENTS');
 const url=new URL(process.env.DATABASE_URL??'');
 client=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000});await client.connect();
 await client.query('BEGIN READ ONLY');
 const plan={version:1,epoch,sourceHost:url.hostname,sourceDatabase:decodeURIComponent(url.pathname.slice(1)),
  membershipApproval:checksum(canonical({epoch,voters:['neon','supabase','turso'],version:1})),
  ...(option('application')?{runtimeApplicationId:option('application')}:{}),guilds:await snapshotLegacy(client,ids)};
 const hash=validateTransferPlan(plan);await client.query('COMMIT');
 // Private configuration snapshot only; never credentials, user profile, or
 // message content. Exclusive creation prevents overwriting an approved plan.
 writeFileSync(out,JSON.stringify(plan,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 console.log(JSON.stringify({mode:'READ_ONLY_SNAPSHOT',guildCount:ids.length,planChecksum:hash,secretsIncluded:false}));
}catch(e){await client?.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({result:'STOPPED',code:/^MDB_[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'MDB_TRANSFER_PLAN_UNAVAILABLE'}));process.exitCode=1;}
finally{await client?.end();}
