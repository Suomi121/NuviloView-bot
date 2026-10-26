import test from 'node:test';import assert from 'node:assert/strict';import {Client} from 'pg';
import {isolatedTursoHttp} from './helpers/isolated-turso-http.mjs';
import {recoveryPlan,recoveryEvidence,recoveryGuild as guild} from './helpers/recovery-fixture.mjs';
import {recoverySchema,recoveryPrefix,bootstrapUnconfirmedRecovery,validateRecoveryPlan} from '../lib/multi-db/recovery-bootstrap.mjs';
import {createSqlAcceptor} from '../lib/multi-db/acceptor.mjs';
import {createCoordinator} from '../lib/multi-db/coordinator.mjs';
import {createSecurityService} from '../lib/multi-db/security-service.mjs';
import {createQuorumNewsControl} from '../lib/multi-db/news-control.mjs';
import {rejoinVoter} from '../lib/multi-db/rejoin.mjs';
test('isolated real PostgreSQL + Turso SDK: no Neon from initial bootstrap through CAS and restart recovery',{skip:!process.env.TEST_COORDINATOR_DATABASE_URL},async t=>{
 const url=new URL(process.env.TEST_COORDINATOR_DATABASE_URL);assert.equal(process.env.TEST_COORDINATOR_ISOLATED,'1');assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.pathname,'/nuviloview_quorum_test');
 const pg=new Client({connectionString:url.href}),neon=new Client({connectionString:url.href});await pg.connect();await neon.connect();t.after(async()=>{await pg.end();await neon.end();});await pg.query('CREATE SCHEMA recovery_test; SET search_path=recovery_test');
 await neon.query('CREATE SCHEMA recovery_neon_test; SET search_path=recovery_neon_test');let neonOnline=false;
 const plan=recoveryPlan(),evidence=recoveryEvidence(plan),prefix=recoveryPrefix(plan.epoch),turso=await isolatedTursoHttp(t);
 await pg.query(recoverySchema(plan.epoch));await turso.client.executeMultiple(recoverySchema(plan.epoch));
 assert.equal(turso.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE ?").get(prefix+'%').n,3,'real SDK sequence installs exactly the new recovery tables');
 const providers=[createSqlAcceptor({id:'neon',dialect:'postgres',tablePrefix:prefix,execute:async(sql,args)=>{if(!neonOnline)throw Error('NEON_OFFLINE');return neon.query(sql,args);}}),
 createSqlAcceptor({id:'supabase',dialect:'postgres',tablePrefix:prefix,execute:(sql,args)=>pg.query(sql,args)}),
 createSqlAcceptor({id:'turso',dialect:'sqlite',tablePrefix:prefix,execute:(sql,args)=>turso.client.execute({sql,args})})];
 const r=await bootstrapUnconfirmedRecovery({providers,plan,evidence,approval:validateRecoveryPlan(plan)});
 const current=await r.security.read(guild);assert.equal(current.value.data.migrationState,'unconfirmed');
 const saved=await r.security.change({guildId:guild,actorId:'isolated-admin',requestId:'confirm-policy',expectedRevision:current.value.revision,expectedChecksum:current.checksum,operation:'policy',value:{...current.value.data.policy,strength:61},acknowledgeRecovery:r.planChecksum,authorize:async()=>true});
 const restarted=createSecurityService(createCoordinator({providers,epoch:plan.epoch}));assert.equal((await restarted.read(guild)).checksum,saved.checksum);assert.equal(await restarted.automaticAllowed(guild,{emergencyStop:false}),false);
 const news=createQuorumNewsControl({...r.coordinator,recovery:{planChecksum:r.planChecksum}});await news.setDestination('isolated-owner',guild,'200000000000000001');assert.equal((await news.destination(guild)).channelId,'200000000000000001');
 turso.setOffline(true);await assert.rejects(restarted.read(guild));turso.setOffline(false);assert.equal((await restarted.read(guild)).checksum,saved.checksum);
 // Only after explicit reviewed rejoin, bring an EMPTY new-epoch Neon namespace
 // online. Original legacy tables are not imported or used as current values.
 await neon.query(recoverySchema(plan.epoch));neonOnline=true;await providers[0].initializeMembership(r.coordinator.membership);
 await rejoinVoter({providers,epoch:plan.epoch,targetId:'neon'});assert.equal((await createCoordinator({providers,epoch:plan.epoch}).read(guild)).checksum,saved.checksum);
});
