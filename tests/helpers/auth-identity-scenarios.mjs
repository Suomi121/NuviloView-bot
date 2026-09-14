import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { randomBytes } from 'node:crypto';

export async function runAuthIdentityScenarios({pool, connectionString, record, stress = false}) {
const repo = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:31957';
const evidence = { externalNetworkRequests: 0 };
let legacyFixturePool;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  evidence.externalNetworkRequests++;
  throw new Error('External HTTP disabled in isolated auth integration test');
};
try {
  process.env.NODE_ENV = 'test';
  process.env.BETTER_AUTH_URL = origin;
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = origin;
  process.env.BETTER_AUTH_SECRET = randomBytes(48).toString('hex');
  process.env.DATABASE_URL = connectionString;
  process.env.NUVILOVIEW_CLIENT_ID = 'fixture-discord-client';
  process.env.NUVILOVIEW_CLIENT_SECRET = 'fixture-discord-secret';
  process.env.NUVILOVIEW_GOOGLE_CLIENT_ID = 'fixture-google-client';
  process.env.NUVILOVIEW_GOOGLE_CLIENT_SECRET = 'fixture-google-secret';
  const postgresModule = await import(pathToFileURL(resolve(repo, 'lib/auth-storage/postgres.ts')));
  globalThis.identityTestStorage = postgresModule.createPostgresAuthStorage({ provider: 'supabase', pool });
  const storageModule = 'data:text/javascript,export const authStorage=globalThis.identityTestStorage;';
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'next/server') return next('next/server.js', context);
      if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
      if (specifier === '@/lib/auth-storage') return { url: storageModule, shortCircuit: true };
      if (specifier.startsWith('@/')) {
        const base = resolve(repo, specifier.slice(2));
        const candidate = [base, `${base}.ts`, `${base}.mjs`, resolve(base, 'index.ts')].find(p => existsSync(p) && statSync(p).isFile());
        if (!candidate) throw new Error(`Missing fixture import: ${specifier}`);
        return next(pathToFileURL(candidate).href, context);
      }
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const base = fileURLToPath(new URL(specifier, context.parentURL));
        if (!existsSync(base) && existsSync(`${base}.ts`)) return next(pathToFileURL(`${base}.ts`).href, context);
      }
      return next(specifier, context);
    },
  });
  const { auth } = await import(pathToFileURL(resolve(repo, 'lib/auth.ts')));
  const context = await auth.$context;
  context.options.rateLimit = { enabled: false }; // Prevent test volume throttling in fixture only.
  const identities = new Map();
  for (const provider of context.socialProviders) {
    provider.createAuthorizationURL = async ({ state }) => new URL(`https://oauth-fixture.invalid/authorize?state=${state}`);
    provider.validateAuthorizationCode = async ({ code }) => ({ accessToken: `fixture-${code}`, scopes: provider.id === 'discord' ? ['identify', 'guilds'] : ['openid', 'email', 'profile'] });
    provider.getUserInfo = async ({ accessToken }) => {
      const code = accessToken.slice('fixture-'.length);
      const id = identities.get(code);
      assert.ok(id, 'The synthetic identity must exist');
      return { user: { id, name: 'Synthetic review user', email: `${provider.id}-${id}@users.invalid`, emailVerified: provider.id === 'google' }, data: {} };
    };
  }
  class Jar {
    values = new Map();
    header() { return [...this.values].map(([k,v]) => `${k}=${v}`).join('; '); }
    absorb(response) {
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        const idx = pair.indexOf('=');
        const key = pair.slice(0, idx), val = pair.slice(idx + 1);
        if (!val || /max-age=0/i.test(value)) this.values.delete(key);
        else this.values.set(key, val);
      }
    }
  }
  async function request(jar, path, body) {
    const headers = { origin, cookie: jar.header() };
    if (body) headers['content-type'] = 'application/json';
    const response = await auth.handler(new Request(`${origin}/api/auth/${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
    jar.absorb(response);
    return response;
  }
  async function begin(jar, provider, link = false) {
    const response = await request(jar, link ? 'link-social' : 'sign-in/social', { provider, callbackURL: `${origin}/account`, disableRedirect: true });
    assert.equal(response.status, 200, 'OAuth initiation must succeed');
    return new URL((await response.json()).url).searchParams.get('state');
  }
  async function complete(jar, provider, state, id) {
    const code = randomBytes(12).toString('hex');
    identities.set(code, id);
    const response = await request(jar, `callback/${provider}?state=${encodeURIComponent(state)}&code=${code}`);
    identities.delete(code);
    return { status: response.status, location: response.headers.get('location') ?? '', body: await response.text() };
  }
  async function login(jar, provider, id) { return complete(jar, provider, await begin(jar, provider), id); }
  async function user(jar) { return (await (await request(jar, 'get-session')).json())?.user; }
  async function countIdentity(provider, id) {
    return (await pool.query('SELECT count(*)::int AS rows, count(DISTINCT "userId")::int AS users FROM account WHERE "providerId"=$1 AND "accountId"=$2', [provider,id])).rows[0];
  }
  const a = new Jar(), b = new Jar(), discordOnly = new Jar();
  assert.equal((await login(a, 'google', 'google-a')).location, `${origin}/account`);
  const aUser = (await user(a)).id;
  const { getManagedGuilds } = await import(pathToFileURL(resolve(repo, 'lib/discord.ts')));
  const beforeNetwork = evidence.externalNetworkRequests;
  const noGuilds = await getManagedGuilds(aUser);
  record('Google-only managed Guild isolation (real repository function)', noGuilds.length === 0 && beforeNetwork === evidence.externalNetworkRequests, { guilds: noGuilds.length });
  const { GET: snapshotGET } = await import(pathToFileURL(resolve(repo, 'app/api/analytics/snapshot/route.ts')));
  legacyFixturePool = (await import(pathToFileURL(resolve(repo, 'lib/db/index.ts')))).pool;
  const denied = await snapshotGET(new Request(`${origin}/api/analytics/snapshot?guildId=1532925691111145644`, { headers: { cookie: a.header() } }));
  record('Google-only private snapshot API denied', denied.status === 403, { httpStatus: denied.status });
  const link = await complete(a, 'discord', await begin(a, 'discord', true), 'discord-x');
  const aAfterLink = (await user(a)).id;
  const linkedCount = (await pool.query('SELECT count(*)::int AS n FROM account WHERE "userId"=$1',[aUser])).rows[0].n;
  record('Google to Discord explicit linking preserves one user', link.location === `${origin}/account` && aAfterLink === aUser && linkedCount === 2, { identities: linkedCount });
  await login(b, 'google', 'google-b');
  for (const [provider,id] of [['discord','discord-x'],['google','google-a']]) {
    const collision = await complete(b, provider, await begin(b, provider, true), id);
    const counts = await countIdentity(provider,id);
    record(`${provider} sequential OAuth identity collision rejected`, collision.location.includes('account_already_linked_to_different_user') && counts.rows === 1, counts);
  }
  await login(discordOnly, 'discord', 'discord-only');
  record('Discord-only fixture login', Boolean(await user(discordOnly)) && (await countIdentity('discord','discord-only')).rows === 1);
  const { GET: guildsGET } = await import(pathToFileURL(resolve(repo, 'app/api/guilds/route.ts')));
  for (const [provider, identity] of [['google', 'google-a'], ['discord', 'discord-x']]) {
    if (provider === 'discord') await globalThis.identityTestStorage.guildAccess.setManagedGuildCache(aUser, [{ id: '1532925691111145644', name: 'Synthetic cached guild' }]);
    const unlinked = await request(a, 'unlink-account', { providerId: provider });
    const left = (await pool.query('SELECT "providerId" FROM account WHERE "userId"=$1', [aUser])).rows;
    record(`${provider} official unlink preserves user and other provider`, unlinked.status === 200 && left.length === 1 && left[0].providerId !== provider && (await user(a)).id === aUser);
    const blocked = await request(a, 'unlink-account', { providerId: left[0].providerId });
    record(`${left[0].providerId}-only official unlink blocked server-side`, blocked.status === 400 && (await pool.query('SELECT count(*)::int n FROM account WHERE "userId"=$1', [aUser])).rows[0].n === 1);
    if (provider === 'discord') {
      const deniedAfter = await snapshotGET(new Request(`${origin}/api/analytics/snapshot?guildId=1532925691111145644`, { headers: { cookie: a.header() } }));
      record('Discord unlink ignores stale managed Guild cache and denies private API', (await getManagedGuilds(aUser)).length === 0 && deniedAfter.status === 403);
    }
    const relinked = await complete(a, provider, await begin(a, provider, true), identity);
    record(`${provider} relink preserves same user and unique identity`, relinked.location === `${origin}/account` && (await user(a)).id === aUser && (await countIdentity(provider, identity)).rows === 1);
  }
  const parallelUnlinks = await Promise.all(['discord', 'google'].map(providerId => request(a, 'unlink-account', { providerId })));
  const survivors = (await pool.query('SELECT "providerId" FROM account WHERE "userId"=$1', [aUser])).rows;
  record('concurrent cross-provider unlink retains at least one login method', survivors.length >= 1 && parallelUnlinks.filter(r => r.status === 200).length <= 1);
  for (const [provider, identity] of [['google', 'google-a'], ['discord', 'discord-x']]) {
    if (!survivors.some(row => row.providerId === provider)) await complete(a, provider, await begin(a, provider, true), identity);
  }
  // Validate real server invalidation for unlinked Google and Discord sessions,
  // not merely removal of a browser's local cookie representation.
  for (const [label, jar] of [['Google-only', b], ['Discord-only', discordOnly]]) {
    const oldCookie = jar.header();
    const out = await request(jar, 'sign-out', {});
    const oldSession = await (await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: oldCookie } }))).json();
    const guildDenied = await guildsGET(new Request(`${origin}/api/guilds`, { headers: { cookie: oldCookie } }));
    const dashboardDenied = await snapshotGET(new Request(`${origin}/api/analytics/snapshot?guildId=1532925691111145644`, { headers: { cookie: oldCookie } }));
    record(`${label} logout invalidates server session and denies Guild and Dashboard APIs`, out.status === 200 && oldSession === null && guildDenied.status === 401 && dashboardDenied.status === 401);
  }
  // Use actual session invalidation and login callbacks, without modifying token checks.
  for (const [from,to] of [['google','google'],['google','discord'],['discord','google'],['discord','discord']]) {
    const jar = new Jar();
    await login(jar, from, from === 'google' ? 'google-a' : 'discord-x');
    const beforeId = (await user(jar)).id;
    const oldCookie = jar.header();
    const out = await request(jar, 'sign-out', {});
    const leaked = await auth.handler(new Request(`${origin}/api/auth/get-session`,{headers:{cookie:oldCookie}}));
    const oldSession = await leaked.json();
    const guildDenied = await guildsGET(new Request(`${origin}/api/guilds`, { headers: { cookie: oldCookie } }));
    const dashboardDenied = await snapshotGET(new Request(`${origin}/api/analytics/snapshot?guildId=1532925691111145644`, { headers: { cookie: oldCookie } }));
    record(`linked ${from} logout denies old-session Guild and Dashboard APIs`, guildDenied.status === 401 && dashboardDenied.status === 401);
    await login(jar, to, to === 'google' ? 'google-a' : 'discord-x');
    record(`${from} logout ${to} relogin preserves user, invalidates old session`, out.status === 200 && oldSession === null && (await user(jar)).id === beforeId);
  }
  // Deterministic legal interleaving: every callback completes its real database
  // identity lookup before any proceeds to createAccount. No result is falsified.
  const originalFind = context.internalAdapter.findAccountByProviderId.bind(context.internalAdapter);
  for (const provider of ['discord','google']) {
    for (const n of (stress ? [2,10,100] : [2,10])) {
      const id = `race-${provider}-${n}`;
      const actors = [];
      for (let i=0;i<n;i++) {
        const jar = new Jar();
        await login(jar,'google',`actor-${provider}-${n}-${i}`);
        actors.push({jar,state:await begin(jar,provider,true)});
      }
      let arrived=0, release;
      const gate = new Promise(r => { release=r; });
      context.internalAdapter.findAccountByProviderId = async (accountId,providerId) => {
        const result = await originalFind(accountId,providerId);
        if(accountId===id && providerId===provider) { arrived++; if(arrived===n) release(); await gate; }
        return result;
      };
      try {
        const outcomes=await Promise.all(actors.map(({jar,state})=>complete(jar,provider,state,id)));
        const counts=await countIdentity(provider,id);
        record(`${provider} concurrent provider identity ${n}`,counts.rows===1 && counts.users===1 && outcomes.filter(o=>o.location===`${origin}/account`).length===1 && outcomes.every(o=>o.location===`${origin}/account` || (o.status===302 && o.location.includes('account_already_linked_to_different_user'))) && outcomes.every(o=>!/(23505|constraint|stack|accessToken|refreshToken)/i.test(o.body)),{participants:n,completed:outcomes.length,successfulRedirects:outcomes.filter(o=>o.location===`${origin}/account`).length,...counts});
      } finally { context.internalAdapter.findAccountByProviderId=originalFind; }
    }
  }
  // Also exercise unconstrained scheduling; there is no test barrier here.
  for (const provider of ['discord','google']) {
    const id = `natural-race-${provider}`;
    const actors = [];
    for(let i=0;i<10;i++) {
      const jar=new Jar(); await login(jar,'google',`natural-actor-${provider}-${i}`);
      actors.push({jar,state:await begin(jar,provider,true)});
    }
    const outcomes=await Promise.all(actors.map(({jar,state})=>complete(jar,provider,state,id)));
    const counts=await countIdentity(provider,id);
    record(`${provider} natural concurrency 10 (no barrier)`,counts.rows===1 && counts.users===1 && outcomes.filter(o=>o.location===`${origin}/account`).length===1 && outcomes.every(o=>o.location===`${origin}/account` || (o.status===302 && o.location.includes('account_already_linked_to_different_user'))) && outcomes.every(o=>!/(23505|constraint|stack|accessToken|refreshToken)/i.test(o.body)),{participants:10,successfulRedirects:outcomes.filter(o=>o.location===`${origin}/account`).length,...counts});
  }
  record('No external network used by isolated review',evidence.externalNetworkRequests===0,{requests:evidence.externalNetworkRequests});

} finally {
  globalThis.fetch = originalFetch;
  if (legacyFixturePool) await legacyFixturePool.end();
}
}
