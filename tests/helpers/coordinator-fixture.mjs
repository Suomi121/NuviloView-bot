import { DatabaseSync } from 'node:sqlite';
import { createCoordinator } from '../../lib/multi-db/coordinator.mjs';
import { ACCEPTOR_SCHEMA,createSqlAcceptor } from '../../lib/multi-db/acceptor.mjs';
export function fixture(t) {
 const dbs=[],faults={},counters={};
 const providers=['neon','supabase','turso'].map(id=>{
  const db=new DatabaseSync(':memory:');db.exec(ACCEPTOR_SCHEMA);dbs.push(db);
  return createSqlAcceptor({id,dialect:'sqlite',execute:async(sql,args)=>{
   if(faults[id]==='offline'||(faults[id]==='readOnly'&&!sql.startsWith('SELECT')))throw Error('PRIVATE_URL_TOKEN');
   counters[id]=(counters[id]??0)+1;return db.prepare(sql).all(...args);
  }});
 });
 const c=createCoordinator({providers,epoch:'isolated-test-v1'});
 for(const [i,db] of dbs.entries())db.prepare('INSERT INTO mdb_membership VALUES(1,?,?)').run(c.membership,providers[i].id);
 t.after(()=>dbs.forEach(db=>db.close()));return{c,providers,dbs,faults,counters};
}
