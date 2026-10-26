import { randomBytes, randomUUID } from 'node:crypto';
import { validateNews, newsDigest, newsError, newsIdValid, classifyNewsFailure } from './news-contract.mjs';
import { normalizeSyncEnvelope } from './sync/conflict-policy.mjs';

const key = id => `news:v1:${id}`;
const destinationKey = guild => `news-destination:v1:${guild}`;
const indexKey = 'news-index:v1';
const copy = value => structuredClone(value);
const statuses = ['pending','sending','sent','unconfigured','failed','unknown','skipped'];

export function createNewsService({ storage, isDeveloper, cloud, ready, destinationControl = null, now = Date.now, randomId = () => randomUUID().replaceAll('-', '') }) {
  if (!storage?.enabled || !storage.writeEnabled) newsError('NEWS_STORAGE_UNAVAILABLE');
  const authority = destinationControl ? 'cloud-quorum-v1' : 'replica-immutable-v1';
  const formSessions = new Map();
  const get = id => {
    if (!/^[a-f\d]{32}$/.test(id ?? '')) newsError('NEWS_ID');
    const record = storage.syncMetadata.get(key(id));
    if (!record?.metadata || record.metadata.id !== id) newsError('NEWS_NOT_FOUND');
    const { checksum, ...news } = record.metadata;
    if (record.state !== news.state || checksum !== newsDigest(news)) newsError('NEWS_STORE_CORRUPT');
    formSessions.set(id, copy(news)); return copy(news);
  };
  const save = news => {
    const result = storage.syncMetadata.set({ streamName: key(news.id), state: news.state, metadata: { ...news, checksum: newsDigest(news) } });
    formSessions.set(news.id, copy(news)); return result;
  };
  function audit(news, action, payload = {}) {
    const eventId = `news-audit:${news.id}:${action}:${randomId()}`;
    const entry = storage.security.appendAudit({ eventId, guildId: 'news-control', category: 'news', action,
      actorId: news.ownerId, status: news.state, occurredAt: now(), payload: { newsId: news.id, ...payload } });
    storage.outbox.enqueue({ eventId, domain: 'security', eventType: 'news_audit_v1', aggregateId: `news:${news.id}`,
      payload: { newsId: news.id, action, ...payload }, schemaVersion: 1, createdAt: entry.occurredAt });
  }
  function requireOwner(news, ownerId) {
    if (!isDeveloper(ownerId) || news.ownerId !== ownerId) newsError('NEWS_FORBIDDEN');
  }
  function checkSession(news, { ownerId, nonce, version, channelId, messageId }) {
    if (!news) newsError('NEWS_STALE_SESSION');
    requireOwner(news, ownerId);
    if (news.expiresAt <= now() || news.nonce !== nonce || news.version !== version ||
        news.dmChannelId !== channelId || news.dmMessageId !== messageId) newsError('NEWS_STALE_SESSION');
    return news;
  }
  function session(input) { return checkSession(get(input.id), input); }
  const envelope = (news, row, type, payload) => normalizeSyncEnvelope({
    eventId: `news:${news.id}:${row.guildId}:${row.attempt}:${type}`, domain: 'security',
    eventType: type === 'claim' ? 'news_delivery_claim_v1' : 'news_delivery_result_v1',
    aggregateId: `news:${news.id}:${row.guildId}`, payload, schemaVersion: 1, priority: 5, createdAt: now(),
  });
  async function healthy() { if (typeof ready !== 'function' || await ready() !== true) newsError('NEWS_NOT_READY'); }
  function changeSession(input, action, fn) {
    return storage.transaction(() => {
      const news = session(input); fn(news); news.version++; save(news); audit(news, action); return news;
    });
  }
  return Object.freeze({ get, session,
    // Only for opening a form within Discord's initial-ACK deadline. This cache
    // never authorizes a DB mutation, confirmation, retry or external send.
    formSession: input => copy(checkSession(formSessions.get(input.id), input)),
    async create(ownerId) {
      if (!isDeveloper(ownerId)) newsError('NEWS_FORBIDDEN');
      const active = (storage.syncMetadata.get(indexKey)?.metadata?.ids ?? []).map(get).some(n => n.ownerId === ownerId && n.expiresAt > now() && ['draft','confirming'].includes(n.state));
      if (active) newsError('NEWS_ACTIVE_DRAFT');
      const news = { id: randomId(), ownerId, nonce: randomBytes(8).toString('hex'), version: 1, state: 'draft',
        authority, createdAt: now(), expiresAt: now() + 15 * 60_000, content: null, targets: [], dmChannelId: null, dmMessageId: null };
      return storage.transaction(() => {
        const ids = storage.syncMetadata.get(indexKey)?.metadata?.ids ?? [];
        if (ids.length >= 1000) newsError('NEWS_HISTORY_CAPACITY');
        storage.syncMetadata.set({ streamName: indexKey, state: 'active', metadata: { ids: [...ids, news.id] } });
        save(news); audit(news, 'created'); return news;
      });
    },
    bind(id, ownerId, channelId, messageId) {
      return storage.transaction(() => {
        const news = get(id); requireOwner(news, ownerId);
        if (news.dmMessageId || !newsIdValid(channelId) || !newsIdValid(messageId)) newsError('NEWS_BIND');
        news.dmChannelId = channelId; news.dmMessageId = messageId; save(news); return news;
      });
    },
    resume(id, ownerId, channelId, messageId) {
      return storage.transaction(() => {
        const n = get(id); requireOwner(n, ownerId);
        if (!newsIdValid(channelId) || !newsIdValid(messageId)) newsError('NEWS_BIND');
        n.nonce = randomBytes(8).toString('hex'); n.version++; n.expiresAt = now() + 15 * 60_000;
        n.dmChannelId = channelId; n.dmMessageId = messageId; save(n); audit(n, 'resumed'); return n;
      });
    },
    abandon(id, ownerId) {
      return storage.transaction(() => {
        const n = get(id); requireOwner(n, ownerId);
        if (n.state === 'draft' && !n.dmMessageId) { n.state = 'cancelled'; save(n); audit(n, 'dm_unavailable'); }
      });
    },
    edit(input, content) { return changeSession(input, 'edited', n => {
      if (n.publicationHash || !['draft','confirming'].includes(n.state)) newsError('NEWS_FROZEN');
      n.content = validateNews(content); n.state = 'draft'; n.targets = []; delete n.retryGuilds;
    }); },
    cancel(input) { return changeSession(input, 'cancelled', n => {
      if (!['draft','confirming'].includes(n.state)) newsError('NEWS_FROZEN');
      if (n.publicationHash) {
        if (!n.retryGuilds) newsError('NEWS_FROZEN');
        delete n.retryGuilds; n.state = 'completed';
      } else n.state = 'cancelled';
    }); },
    destination(guildId) {
      if (!newsIdValid(guildId)) newsError('NEWS_GUILD');
      if (destinationControl) return destinationControl.destination(guildId);
      return storage.syncMetadata.get(destinationKey(guildId))?.metadata ?? { guildId, channelId: null, revision: 0 };
    },
    setDestination(ownerId, guildId, channelId, input = null) {
      if (!isDeveloper(ownerId) || !newsIdValid(guildId) || (channelId !== null && !newsIdValid(channelId))) newsError('NEWS_FORBIDDEN');
      if (destinationControl) {
        if (input) session(input);
        return destinationControl.setDestination(ownerId, guildId, channelId).then(metadata => storage.transaction(() => {
          if (input) { const n = session(input); n.version++; save(n); }
          audit({ id: `destination:${guildId}`, ownerId, state: 'saved' }, 'destination', metadata);
          return metadata;
        }));
      }
      return storage.transaction(() => {
        if (input) { const n = session(input); n.version++; save(n); }
        const old = storage.syncMetadata.get(destinationKey(guildId))?.metadata;
        const metadata = { guildId, channelId, revision: (old?.revision ?? 0) + 1 };
        storage.syncMetadata.set({ streamName: destinationKey(guildId), state: 'active', metadata });
        audit({ id: `destination:${guildId}`, ownerId, state: 'saved' }, 'destination', metadata);
        return metadata;
      });
    },
    async prepare(input, guildIds, retry = false) {
      session(input); await healthy();
      if (!Array.isArray(guildIds) || guildIds.some(id => !newsIdValid(id)) || new Set(guildIds).size > 10000) newsError('NEWS_GUILDS');
      const destinations = destinationControl && !retry ? new Map(await Promise.all([...new Set(guildIds)].map(async id => [id, await destinationControl.destination(id)]))) : null;
      return changeSession(input, retry ? 'retry_planned' : 'planned', n => {
        validateNews(n.content);
        if (retry) {
          if (!['completed','paused'].includes(n.state)) newsError('NEWS_FROZEN');
          n.retryGuilds = n.targets.filter(row => row.status === 'failed' && (row.retryAt ?? 0) <= now() && guildIds.includes(row.guildId)).map(row => row.guildId);
          if (!n.retryGuilds.length) newsError('NEWS_NO_RETRY_TARGET');
        } else {
          if (n.state !== 'draft') newsError('NEWS_FROZEN');
          n.targets = [...new Set(guildIds)].sort().map(guildId => {
            const dest = destinations?.get(guildId) ?? storage.syncMetadata.get(destinationKey(guildId))?.metadata;
            return { guildId, channelId: dest?.channelId ?? null, destinationRevision: dest?.revision ?? 0,
              status: dest?.channelId ? 'pending' : 'unconfigured', attempt: 0 };
          });
        }
        n.state = 'confirming'; n.confirmHash = newsDigest({ content: n.content, targets: n.targets, retry: n.retryGuilds ?? null });
      });
    },
    async confirm(input) {
      session(input); await healthy();
      return changeSession(input, 'confirmed', n => {
        if (n.state !== 'confirming' || n.confirmHash !== newsDigest({ content: n.content, targets: n.targets, retry: n.retryGuilds ?? null })) newsError('NEWS_CONFIRM_REQUIRED');
        if (n.retryGuilds) {
          for (const row of n.targets.filter(r => n.retryGuilds.includes(r.guildId))) row.status = 'pending';
          delete n.retryGuilds;
        }
        n.state = 'queued';
        n.publicationHash = newsDigest(n.content);
        audit(n, 'publication', { content: n.content, targetCount: n.targets.length });
      });
    },
    list: () => (storage.syncMetadata.get(indexKey)?.metadata?.ids ?? []).map(get),
    recover() {
      // Old in-flight Discord calls are never put back on the sending queue.
      return storage.transaction(() => {
        for (const id of storage.syncMetadata.get(indexKey)?.metadata?.ids ?? []) {
          const news = get(id); let changed = false;
          for (const row of news.targets) if (row.status === 'sending') { row.status = 'unknown'; row.code = 'PROCESS_INTERRUPTED'; changed = true; }
          if (changed) { save(news); audit(news, 'recovered_unknown'); }
        }
      });
    },
    async deliverOne(id, transport) {
      const initial = get(id);
      if (!['queued','running'].includes(initial.state)) return false;
      if ((initial.authority ?? 'replica-immutable-v1') !== authority) {
        storage.transaction(()=>{const n=get(id);n.state='paused';n.suspensionReason='NEWS_AUTHORITY_TRANSFER_REQUIRED';save(n);audit(n,'authority_transfer_required');});
        return false;
      }
      if (!isDeveloper(initial.ownerId)) return false;
      if (initial.publicationHash !== newsDigest(initial.content)) newsError('NEWS_CONTENT_CHANGED');
      try { await healthy(); } catch { return false; }
      const next = initial.targets.find(r => r.status === 'pending');
      let agreedDestination;
      if (destinationControl && next) {
        try { agreedDestination = await destinationControl.destination(next.guildId); } catch { return false; }
      }
      let row;
      const news = storage.transaction(() => {
        const n = get(id); if (!['queued','running'].includes(n.state)) return null;
        const pending = n.targets.find(r => r.status === 'pending');
        if (!pending) {
          if (!n.targets.some(r => r.status === 'sending')) { n.state = 'completed'; save(n); audit(n, 'completed'); }
          return null;
        }
        const dest = agreedDestination ?? storage.syncMetadata.get(destinationKey(pending.guildId))?.metadata;
        if (!dest || dest.channelId !== pending.channelId || dest.revision !== pending.destinationRevision) {
          pending.status = 'skipped'; pending.code = 'DESTINATION_CHANGED'; save(n); audit(n, 'destination_changed', { guildId: pending.guildId }); return null;
        }
        row = pending; row.status = 'sending'; row.attempt++; row.claimNonce = randomId(); n.state = 'running'; save(n);
        audit(n, 'claimed_locally', { guildId: row.guildId, attempt: row.attempt }); return n;
      });
      if (!news) return true;
      let result;
      try {
        if (row.attempt > 1 && (!row.claimHash || !row.resultEventId || !row.resultHash ||
            !await cloud.verify(`news:${news.id}:${row.guildId}:${row.attempt - 1}:claim`, row.claimHash) ||
            !await cloud.verify(row.resultEventId, row.resultHash))) newsError('NEWS_RETRY_UNVERIFIED');
        const claim = envelope(news, row, 'claim', { newsId: id, guildId: row.guildId, channelId: row.channelId,
          contentHash: newsDigest(news.content), claimNonce: row.claimNonce, attempt: row.attempt });
        row.claimHash = await cloud.claim(claim);
        storage.transaction(() => {
          const n = get(id), target = n.targets.find(r => r.guildId === row.guildId);
          if (target.status !== 'sending' || target.claimNonce !== row.claimNonce) newsError('NEWS_CLAIM_LOST');
          target.claimHash = row.claimHash; save(n); storage.outbox.enqueue(claim);
        });
        // Only the elected claim owner may establish a retryable negative
        // outcome. A losing writer's validation failure is NOT proof of no send.
        await transport.validate(row, news);
        await healthy();
        const liveDestination = destinationControl ? await destinationControl.destination(row.guildId)
          : storage.syncMetadata.get(destinationKey(row.guildId))?.metadata;
        if(!liveDestination||liveDestination.channelId!==row.channelId||liveDestination.revision!==row.destinationRevision)newsError('NEWS_DESTINATION_CHANGED');
        if (!isDeveloper(news.ownerId)) newsError('NEWS_FORBIDDEN');
        // One local atomic claim plus intersecting immutable cloud claims.
        // No Worker or automatic retry executes this external effect.
        const sent = await transport.send(row, news);
        if (!newsIdValid(sent?.id) || sent.channelId !== row.channelId || sent.guildId !== row.guildId) newsError('NEWS_RESPONSE_MISMATCH');
        result = { status: 'sent', messageId: sent.id, code: null };
      } catch (error) {
        const code = String(error?.code ?? '');
        const skipped = ['NEWS_NOT_JOINED','NEWS_DUPLICATE','NEWS_DESTINATION_CHANGED'].includes(code);
        const rejected = ['NEWS_PERMISSION','NEWS_CHANNEL'].includes(code);
        const category = classifyNewsFailure(error);
        const safeCodes = new Set(['NEWS_EXISTING_CLAIM','NEWS_RETRY_UNVERIFIED','NEWS_CLOUD_UNAVAILABLE',
          'NEWS_CLOUD_OUTCOME_UNKNOWN','NEWS_NOT_READY','NEWS_RESPONSE_MISMATCH','NEWS_FORBIDDEN']);
        result = { status: skipped ? 'skipped' : rejected || ['RATE_LIMIT','FORBIDDEN','NOT_FOUND','REJECTED'].includes(category) ? 'failed' : 'unknown',
          code: skipped || rejected || safeCodes.has(code) ? code : category, messageId: null,
          ...(category === 'RATE_LIMIT' ? { retryAt: now() + Math.max(60, Math.min(86400, Number(error?.rawError?.retry_after ?? error?.retry_after) || 60)) * 1000 } : {}) };
      }
      // A failure here leaves 'sending', recovered to UNKNOWN. Never send twice.
      storage.transaction(() => {
        const n = get(id), target = n.targets.find(r => r.guildId === row.guildId);
        if (target.status !== 'sending' || target.claimNonce !== row.claimNonce) newsError('NEWS_CLAIM_LOST');
        Object.assign(target, result); save(n); audit(n, 'delivery', { guildId: row.guildId, attempt: row.attempt, ...result });
      });
      const outcome = envelope(news, row, 'result', { newsId: id, guildId: row.guildId, attempt: row.attempt,
        claimNonce: row.claimNonce, claimHash: row.claimHash ?? null, ...result });
      try {
        storage.transaction(() => storage.outbox.enqueue(outcome));
        const resultHash = await cloud.record(outcome);
        storage.transaction(() => {
          const n = get(id), target = n.targets.find(r => r.guildId === row.guildId);
          target.resultEventId = outcome.eventId; target.resultHash = resultHash; save(n);
        });
      } catch { /* Missing durable outcome blocks manual retries. */ }
      return true;
    },
    stats(id) {
      const news = get(id), counts = Object.fromEntries(statuses.map(s => [s, news.targets.filter(r => r.status === s).length]));
      return { total: news.targets.length, ...counts, state: news.state };
    },
  });
}
