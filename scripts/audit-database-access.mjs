import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function classifyDatabaseAccess(path) {
  if (/auth-storage|lib\/auth\.ts|auth-provider|auth-unlink|lib\/discord\.ts|developer-access|social-login-state|account-connections|api\/guilds\/route|settings\/(theme|timezone)/.test(path)) return 'DEDICATED_AUTH_AUTHORITY';
  if (/multi-db\//.test(path)) return 'QUORUM_AND_ERASURE';
  if (/sync\/|run-sync-worker|storage\/|local-first|canary/.test(path)) return 'LOCAL_FIRST_REPLICATION';
  if (/goals\/|notifications\/|request-security|web-analytics-read|web-read-router|channel-metadata|analytics\/|monitor\/bot|backend\/status/.test(path)) return 'APPLICATION_HA_WITH_LEGACY_COMPAT';
  if (/spam|security-|timeout-|news-/.test(path)) return 'SECURITY_OR_NEWS_QUORUM_WITH_LEGACY_COMPAT';
  if (/reset|history-import|guild-reset|developer\/guilds/.test(path)) return 'PENDING_DESTRUCTIVE_JOB_PROTOCOL';
  if (/support/.test(path)) return 'ENCRYPTED_APPLICATION_CLAIM_EXTERNAL_PROVIDER';
  if (/messages\/search/.test(path)) return 'PENDING_ENCRYPTED_MESSAGE_INDEX';
  if (/developer\/runtime|runtime-singleton/.test(path)) return 'RUNTIME_QUORUM_WITH_LEGACY_MONITOR';
  if (path === 'discord-bot.mjs') return 'MIXED_BOT_LEGACY_CALLS_REQUIRE_PORT';
  if (/lib\/db\/|cloud-database/.test(path)) return 'LEGACY_NEON_CONNECTOR';
  if (/^scripts\//.test(path)) return 'OFFLINE_OPERATIONAL_TOOL_REQUIRES_TARGET_REVIEW';
  return 'REVIEW_REQUIRED';
}

export function auditDatabaseAccess(root = process.cwd()) {
  const files = [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/))];
  const rows = [];
  for (const path of files.filter(p => /^(app|lib|scripts)\/.*\.(ts|tsx|mjs|js)$/.test(p) || p === 'discord-bot.mjs')) {
    const source = readFileSync(resolve(root,path),'utf8'), sites = [];
    source.split(/\r?\n/).forEach((line,index) => {
      const kinds = [];
      if (/(?:from|import\().*(?:lib\/db|@neondatabase|\bpg['"]|cloud-database|auth-storage)/.test(line)) kinds.push('connection-import');
      if (/\bnew (?:Pool|Client|DatabaseSync)\b|\bneon\(|\bcreateClient\(/.test(line)) kinds.push('connection-construction');
      if (/(?:\bsql\s*`|\.(?:execute|executeMultiple|batch)\s*\(|\.query(?:<[^>]*>)?\s*\(|\b(?:store|db|database|connection)\.(?:run|get|all|exec|execute|prepare|select|insert|update|delete)\s*\(|\bauthStorage\.\w+\.\w+\()/.test(line)) kinds.push('database-call');
      if (kinds.length) sites.push({line:index+1,kinds});
    });
    if (!sites.length) continue;
    const tables = [...new Set([...source.matchAll(/\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+["`]?([a-zA-Z_][\w.]*)/gi)].map(m=>m[1]))].sort();
    rows.push({path,classification:classifyDatabaseAccess(path),sites,tables});
  }
  return {version:1,method:'conservative static call-site inventory; dynamic SQL requires manual review',files:rows.length,callSites:rows.reduce((n,r)=>n+r.sites.length,0),rows};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result=auditDatabaseAccess();
  if(process.argv.includes('--check')){const unclassified=result.rows.filter(r=>r.classification==='REVIEW_REQUIRED').map(r=>r.path);console.log(JSON.stringify({files:result.files,callSites:result.callSites,unclassified}));if(unclassified.length)process.exitCode=1;}
  else console.log(JSON.stringify(result,null,2));
}
