import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNewsService } from './news-service.mjs';
import { createNewsCloudGuard } from './news-cloud-guard.mjs';
import { createNewsDiscord } from './news-discord.mjs';
import { isNewsDeveloper } from './news-contract.mjs';
import { getMultiDbSyncConfig } from './sync/multi-config.mjs';
import { createProviderRegistry } from './sync/providers/registry.mjs';
import { createQuorumNewsControl } from './multi-db/news-control.mjs';
import { createNewsDestinationSelector } from './news-destinations.mjs';
import { createNewsActivityReader } from './news-activity-reader.mjs';

export function newsHealthReady({ storage, snapshot, now = Date.now() }) {
  if (!storage?.enabled || !storage.writeEnabled || !storage.health.checkIntegrity({ quick: true }).ok) return false;
  if (snapshot?.mode !== 'MULTI_DB_SYNC_V1' || snapshot.workerStatus !== 'RUNNING' || snapshot.workerHealth !== 'HEALTHY' ||
      !Number.isFinite(snapshot.generatedAt) || now - snapshot.generatedAt < 0 || now - snapshot.generatedAt > 90_000 ||
      snapshot.sqlite?.status !== 'HEALTHY' || !snapshot.sqlite?.integrity?.ok) return false;
  const enabled = Object.values(snapshot.providers ?? {}).filter(p => p.enabled);
  return enabled.length >= 2 && enabled.every(p => !p.required || p.healthStatus === 'HEALTHY') &&
    storage.providerDeliveries.getAllProviderStatus().every(p => !p.enabled || !p.required || (p.deadLetter === 0 && p.healthStatus === 'HEALTHY'));
}

export async function createNewsRuntime({ storage, client, env = process.env, coordinator = null }) {
  const isDeveloper = id => isNewsDeveloper(id, env);
  const disabled = {
    enabled: false,
    async message(m) {
      if (!/^s\?news(?:\s|$)/i.test(m.content ?? '')) return false;
      if (m.author.bot || m.webhookId || !isDeveloper(m.author.id)) return false;
      await m.author.send({ content: 'ニュース配信は未設定か停止中です。開発者向けの有効化・DB設定を確認してね。', allowedMentions: { parse: [] } }).catch(() => {});
      return true;
    },
    async interaction(i) {
      if (!i.customId?.startsWith('nvnews:')) return false;
      await i.reply({ content: 'ニュース配信は停止中です。', flags: 64 }).catch(() => {}); return true;
    },
    stop: async () => {},
  };
  if (env.NEWS_BROADCAST_ENABLED !== 'true') return disabled;
  const config = getMultiDbSyncConfig(env);
  if (!coordinator && (!config.enabled || !config.workerEnabled)) return disabled;
  let registry,activityReader;
  try {
    registry = coordinator ? null : await createProviderRegistry({ config, logger: { warn() {} } });
    const cloud = coordinator ? createQuorumNewsControl(coordinator) : createNewsCloudGuard({ registry });
    let stopping = false, active = null;
    const ready = async () => {
      if (stopping || !client.isReady()) return false;
      try {
        if (coordinator) return storage?.enabled === true && storage.writeEnabled === true &&
          storage.health.checkIntegrity({ quick: true }).ok === true;
        const snapshot = JSON.parse(readFileSync(resolve(config.metricsPath), 'utf8'));
        return newsHealthReady({ storage, snapshot });
      } catch { return false; }
    };
    activityReader=createNewsActivityReader(storage);
    const selectDestination=createNewsDestinationSelector({client,activity:(guildId,options)=>activityReader.read(guildId,options)});
    const service = createNewsService({ storage, isDeveloper, cloud, ready, destinationControl: coordinator ? cloud : null,selectDestination });
    const discord = createNewsDiscord({ service, client, isDeveloper });
    // Serial, bounded throughput. Discord.js additionally manages REST 429 limits.
    const tick = async () => {
      if (stopping || active || !client.isReady()) return;
      active = (async () => {
        service.recover(); // No local dispatch is active; quarantine any interrupted persistence outcome.
        const news = service.list().find(n => ['queued','running'].includes(n.state));
        if (!news) return;
        try { await service.deliverOne(news.id, discord.transport); }
        finally { await discord.refresh(service.get(news.id)).catch(() => {}); }
      })();
      try { await active; } catch { /* No raw provider errors or content in logs. Durable claims remain. */ }
      finally { active = null; }
    };
    const timer = setInterval(() => void tick(), 1500); timer.unref();
    return { ...discord, service, enabled: true,
      async stop() {
        stopping = true; clearInterval(timer);
        if (active) {
          let timeout;
          try { await Promise.race([active, new Promise(r => { timeout = setTimeout(r, 20_000); })]); }
          catch { /* Restart recovery quarantines any in-flight claim. */ }
          finally { clearTimeout(timeout); }
        }
        await registry?.close();
        await activityReader.close();
      },
    };
  } catch { await registry?.close(); await activityReader?.close();return disabled; }
}
