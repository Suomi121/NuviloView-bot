import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { newsPayload, newsIdValid, newsError, newsDigest } from './news-contract.mjs';
import { createInteractionLimiter } from './security-operators.mjs';
import { freshNewsBot,newsChannelUsable } from './news-destinations.mjs';

const custom = (n, action) => `nvnews:${n.id}:${n.nonce}:${n.version}:${action}`;
const selectionLabels={explicit:'明示設定',activity:'活動量（直近7日）',fallback:'Fallback',unavailable:'配信不能'};
const selectionReasons={NO_SENDABLE_CHANNEL:'送信可能な候補なし',CHANNEL_DISCOVERY_INCOMPLETE:'候補取得の一部を確認できません',
  CHANNEL_DISCOVERY_FAILED:'チャンネル一覧を確認できません',GUILD_UNAVAILABLE:'Guildを確認できません',
  GUILD_OR_PERMISSIONS_UNAVAILABLE:'GuildまたはBot権限を確認できません',CHANNEL_CAPACITY:'候補数の安全上限を超えています'};
export function newsTargetsPage(news,page=0){
  const size=8,pages=Math.max(1,Math.ceil(news.targets.length/size));
  if(!Number.isInteger(page)||page<0||page>=pages)newsError('NEWS_PAGE');
  const rows=news.targets.slice(page*size,(page+1)*size).map(r=>{
    const mode=r.selection?.mode??(r.channelId?'explicit':'unavailable');
    return`Guild ${r.guildId} → ${r.channelId?`<#${r.channelId}>`:'送信しません'}\n`+
      `${selectionLabels[mode]??'未確認'}${mode==='activity'?` / ${r.selection.activity.messages}件（観測済み）`:''}`+
      (r.selection?.explicitUnavailable?' / 明示先は送信不能':'' )+
      (!r.channelId?` / ${selectionReasons[r.selection?.reason]??'送信先未確定'}`:'');
  });
  const navigation=new ActionRowBuilder().addComponents(['前へ','次へ'].map((label,i)=>new ButtonBuilder()
    .setCustomId(`${custom(news,`targets${i?page+1:page-1}`)}:${news.dmMessageId}`)
    .setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(i?page+1>=pages:page===0)));
  // Disabled buttons must still have valid IDs (negative page is not a route).
  if(page===0)navigation.components[0].setCustomId(`${custom(news,'targets0')}:${news.dmMessageId}`);
  return{content:`配信先一覧 ${page+1}/${pages}（対象${news.targets.length} Guild）\n確認後はこの配信先を固定します。失敗しても別チャンネルへ切り替えません。\n\n${rows.join('\n\n')||'候補はまだありません。'}`,
    components:[navigation],allowedMentions:{parse:[]}};
}
export async function liveNewsGuildIds(client) {
  const ids = new Set(); let after;
  for (;;) {
    const page = await client.guilds.fetch({ limit: 200, ...(after ? { after } : {}) });
    if (!page || typeof page.keys !== 'function' || page.size > 200) newsError('NEWS_GUILD_INVENTORY');
    const batch = [...page.keys()];
    if (batch.some(id => !newsIdValid(id)) || batch.some(id => after && BigInt(id) <= BigInt(after))) newsError('NEWS_GUILD_INVENTORY');
    for (const id of batch) ids.add(id);
    if (ids.size > 10000) newsError('NEWS_GUILD_CAPACITY');
    if (page.size < 200) return ids;
    after = batch.reduce((max,id) => BigInt(id) > BigInt(max) ? id : max, after ?? '0');
  }
}
function modal(news, action, fields) {
  return new ModalBuilder().setCustomId(custom(news, action)).setTitle(action === 'save' ? 'ニュースを編集' : 'ニュース配信先の設定')
    .addComponents(fields.map(([id, label, max, value, required, multiline]) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setMaxLength(max).setRequired(required)
        .setStyle(multiline ? TextInputStyle.Paragraph : TextInputStyle.Short).setValue(value || ''),
    )));
}
export function newsScreen(news, stats) {
  const editable = !news.publicationHash && ['draft','confirming'].includes(news.state), confirm = news.state === 'confirming';
  const reviewRows=news.retryGuilds?news.targets.filter(r=>news.retryGuilds.includes(r.guildId)):news.targets;
  const available=reviewRows.filter(r=>r.channelId).length;
  const selected=Object.fromEntries(['explicit','activity','fallback'].map(mode=>[mode,reviewRows.filter(r=>(r.selection?.mode??(r.channelId?'explicit':'unavailable'))===mode).length]));
  const controls = [
    ['edit','内容を編集',ButtonStyle.Primary,!editable],
    ['preview','プレビュー',ButtonStyle.Secondary,!news.content],
    [confirm ? 'confirm' : 'plan', confirm ? 'この内容・対象に確定配信' : '全Guildに送信',ButtonStyle.Danger,(!editable && !confirm) || !news.content],
    ['cancel','キャンセル',ButtonStyle.Secondary,!editable && !confirm],
  ].map(([action,label,style,disabled]) => new ButtonBuilder().setCustomId(custom(news,action)).setLabel(label).setStyle(style).setDisabled(disabled));
  const extra = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(custom(news,'destination')).setLabel('配信先設定').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(custom(news,'status')).setLabel('配送結果を更新').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(custom(news,'retry')).setLabel('失敗Guildへの再送を確認').setStyle(ButtonStyle.Danger).setDisabled(!['completed','paused'].includes(news.state) || !stats.failed),
    new ButtonBuilder().setCustomId(custom(news,'targets0')).setLabel('配信先一覧').setStyle(ButtonStyle.Secondary).setDisabled(!news.targets.length),
  );
  return { ...(news.content ? newsPayload(news) : { embeds: [{ title: 'NuviloView ニュース作成', description: '内容を編集してプレビューを確認してね。' }] }),
    content: `開発者専用 · News ID: ${news.id}\n状態: ${news.state}\n対象Guild: ${stats.total} / 成功: ${stats.sent} / 配信不能・未確認: ${(stats.unavailable??0)+stats.unconfigured} / 失敗: ${stats.failed} / 結果不明: ${stats.unknown} / 未送信: ${stats.pending} / 送信中: ${stats.sending} / 対象外: ${stats.skipped}` +
      (confirm ? `\n最終確認：対象${reviewRows.length} Guild / 配信可能${available} / 配信不能・未確認${reviewRows.length-available}\n`+
        `明示設定${selected.explicit} / 活動量${selected.activity} / Fallback${selected.fallback}\n「配信先一覧」で確認してください。結果不明への再送はしません。` : '') +
      (['completed','paused'].includes(news.state) ? '\n失敗・結果不明の詳細は「配送結果を更新」で確認できます。' : '') +
      (news.suspensionReason === 'NEWS_AUTHORITY_TRANSFER_REQUIRED' ? '\n配送権威が変更されています。履歴照合と承認された移管なしに再送しません。' : ''),
    components: [new ActionRowBuilder().addComponents(controls),extra], allowedMentions: { parse: [] } };
}

export function createNewsDiscord({ service, client, isDeveloper, allow = createInteractionLimiter({ intervalMs: 750, maxEntries: 100 }) }) {
  const transport = {
    async validate(row, news) {
      const current = await liveNewsGuildIds(client);
      if (!current.has(row.guildId)) newsError('NEWS_NOT_JOINED');
      const guild = await client.guilds.fetch(row.guildId);
      const channel = await guild.channels.fetch(row.channelId, { force: true });
      const bot = await freshNewsBot(guild,client);
      if (channel?.guildId !== guild.id) newsError('NEWS_CHANNEL');
      if (!newsChannelUsable(channel,bot,guild.id)) newsError('NEWS_PERMISSION');
      // A positive match prevents duplication. Absence is never used to retry UNKNOWN.
      if(channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory)){
        let history;try{history=await channel.messages.fetch({limit:100});}catch{/* Optional positive check; quorum proof remains mandatory. */}
        if(history?.some(m=>m.author?.id===client.user.id&&m.embeds?.some(e=>e.footer?.text===`NuviloView News · ${news.id}`)))newsError('NEWS_DUPLICATE');
      }
    },
    async send(row, news) {
      const current = await liveNewsGuildIds(client);
      if (!current.has(row.guildId)) newsError('NEWS_NOT_JOINED');
      const guild = await client.guilds.fetch(row.guildId);
      const channel = await guild.channels.fetch(row.channelId, { force: true });
      const bot = await freshNewsBot(guild,client);
      if (channel?.guildId !== row.guildId) newsError('NEWS_CHANNEL');
      if (!newsChannelUsable(channel,bot,row.guildId)) newsError('NEWS_PERMISSION');
      return channel.send({ ...newsPayload(news), nonce: newsDigest([news.id,row.guildId]).slice(0,24), enforceNonce: true });
    },
  };
  async function refresh(news) {
    const user = await client.users.fetch(news.ownerId), dm = await user.createDM();
    if (dm.id !== news.dmChannelId) newsError('NEWS_DM_MISMATCH');
    await dm.messages.edit(news.dmMessageId, newsScreen(news, service.stats(news.id)));
  }
  const safeReply = (interaction, content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  return Object.freeze({ transport, refresh,
    async message(message) {
      const match = /^s\?news(?:\s+status\s+([a-f\d]{32}))?\s*$/i.exec(message.content ?? '');
      if (!match) return false;
      if (message.author.bot || message.webhookId || !isDeveloper(message.author.id)) return false;
      if (!allow(`message:${message.author.id}`)) return true;
      let created = null;
      try {
        const news = match[1] ? service.get(match[1]) : await service.create(message.author.id);
        if (!match[1]) created = news;
        if (news.ownerId !== message.author.id) newsError('NEWS_FORBIDDEN');
        const dm = await message.author.createDM();
        const sent = await dm.send({ content: 'ニュース作成画面を準備しています。', allowedMentions: { parse: [] } });
        const bound = match[1] ? service.resume(news.id,message.author.id,dm.id,sent.id) : service.bind(news.id,message.author.id,dm.id,sent.id);
        await sent.edit(newsScreen(bound,service.stats(news.id)));
      } catch {
        if (created) { try { service.abandon(created.id,message.author.id); } catch { /* Preserve unresolved durable records. */ } }
        // Never print draft/news/errors into a public channel.
        await message.author.send({ content: '作成画面を開けませんでした。DM設定・保存先・既存の有効な下書きを確認してね。', allowedMentions: { parse: [] } }).catch(() => {});
      }
      return true;
    },
    async interaction(i) {
      if (!i.customId?.startsWith('nvnews:')) return false;
      const parts = /^nvnews:([a-f\d]{32}):([a-f\d]{16}):(\d{1,8}):([a-z]+\d{0,4})(?::(\d{16,22}))?$/.exec(i.customId);
      if (!parts || !isDeveloper(i.user.id) || i.guildId || (parts[5]&&!/^targets\d+$/.test(parts[4]))) {
        await i.reply({ content: 'この操作は利用できません。', flags: MessageFlags.Ephemeral }).catch(() => {}); return true;
      }
      if (!allow(`interaction:${i.user.id}`)) {
        await i.reply({ content: '少し待ってから操作してね。', flags: MessageFlags.Ephemeral }).catch(() => {}); return true;
      }
      const input = { id: parts[1], nonce: parts[2], version: Number(parts[3]), ownerId: i.user.id,
        channelId: i.channelId, messageId: parts[5]??i.message?.id };
      const action = parts[4];
      // Modal-opening ACK must be showModal itself, before any network/DB waits.
      if (i.isButton() && ['edit','destination'].includes(action)) {
        let attempted = false;
        try {
          const news = service.formSession(input);
          if (action === 'edit' && (news.publicationHash || !['draft','confirming'].includes(news.state))) newsError('NEWS_FROZEN');
          const form = action === 'edit' ? modal(news,'save',[
            ['title','タイトル',256,news.content?.title,true,false],['body','本文',4000,news.content?.body,true,true],
            ['url','リンク（HTTPS・任意）',1024,news.content?.url,false,false],['color','カラー（#RRGGBB・任意）',7,news.content?.color,false,false],
          ]) : modal(news,'setdest',[
            ['guild','Guild ID',22,'',true,false],['channel','Channel ID（解除は off）',22,'',true,false],
          ]);
          attempted = true; await i.showModal(form);
        } catch {
          if (!attempted) await i.reply({ content: '操作期限切れか、許可されていない操作です。', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return true;
      }
      try { if(parts[5])await i.deferUpdate();else await i.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return true; }
      try {
        let news = service.session(input);
        if(/^targets\d+$/.test(action)&&i.isButton())return await i.editReply(newsTargetsPage(news,Number(action.slice(7))));
        if (action === 'save' && i.isModalSubmit()) {
          news = service.edit(input, Object.fromEntries(['title','body','url','color'].map(name => [name,i.fields.getTextInputValue(name)])));
        } else if (action === 'setdest' && i.isModalSubmit()) {
          const guildId = i.fields.getTextInputValue('guild').trim(), channelValue = i.fields.getTextInputValue('channel').trim();
          if (!newsIdValid(guildId) || (channelValue !== 'off' && !newsIdValid(channelValue))) newsError('NEWS_DESTINATION');
          const guilds = await liveNewsGuildIds(client); if (!guilds.has(guildId)) newsError('NEWS_NOT_JOINED');
          const channelId = channelValue === 'off' ? null : channelValue;
          if (channelId) {
            const guild = await client.guilds.fetch(guildId), channel = await guild.channels.fetch(channelId,{force:true});
            const bot = await freshNewsBot(guild,client);
            if (!newsChannelUsable(channel,bot,guildId)) newsError('NEWS_PERMISSION');
          }
          service.session(input); await service.setDestination(i.user.id,guildId,channelId,input); news = service.get(news.id);
        } else if (action === 'cancel') news = service.cancel(input);
        else if (action === 'preview') { await safeReply(i,'配信予定のプレビューです。'); await i.followUp({ ...newsPayload(news), flags: MessageFlags.Ephemeral }); return true; }
        else if (action === 'status') {
          const lines = news.targets.filter(r => ['failed','unknown','skipped','unconfigured','unavailable'].includes(r.status)).map(r => `${r.guildId}: ${r.status} (${r.code ?? r.selection?.reason ?? 'DESTINATION_NOT_CONFIGURED'})`);
          await safeReply(i,`配送状態: ${JSON.stringify(service.stats(news.id))}`);
          if (lines.length) await i.followUp({
            ...(lines.length <= 15 ? { content: lines.join('\n') }
              : { files: [{ attachment: Buffer.from(lines.join('\n'),'utf8'), name: `news-${news.id}-delivery.txt` }] }),
            flags: MessageFlags.Ephemeral, allowedMentions:{parse:[]},
          });
          await refresh(news).catch(() => {}); return true;
        } else if (action === 'plan' || action === 'retry') {
          news = await service.prepare(input,[...await liveNewsGuildIds(client)],action === 'retry');
        } else if (action === 'confirm') news = await service.confirm(input);
        else newsError('NEWS_OPERATION');
        await safeReply(i,action === 'confirm' ? '配信を受け付けたよ。配送結果はこのDM画面で確認できます。' : '更新したよ。');
        await refresh(news).catch(() => {});
      } catch (error) {
        const messages = {
          NEWS_CONTENT_LIMIT:'タイトルは1〜256文字、本文は1〜4000文字で入力してね。',
          NEWS_URL:'リンクは認証情報を含まない公開HTTPS URLを使ってね。',
          NEWS_COLOR:'カラーは #RRGGBB 形式で入力してね。',
          NEWS_NO_RETRY_TARGET:'再送できる失敗Guildがありません。結果不明やRate Limit待機中は再送しません。',
          NEWS_STALE_SESSION:'操作期限切れか古い画面です。',
          NEWS_NOT_READY:'Multi-DBの準備状態を確認できません。新たな配信は停止しています。',
          NEWS_DESTINATION_MIGRATION_REQUIRED:'旧配信先設定の移管を確認できません。設定を推測して自動配信はしません。',
          NEWS_FROZEN:'このニュース本文は確定済みです。変更できません。',
        };
        await safeReply(i,`${messages[error?.code] ?? '操作結果を確認できませんでした。'}\ns?news status ${input.id} で確認してね。結果を確認する前に新しいニュースを作成・再送しないでください。`).catch(() => {});
      }
      return true;
    },
  });
}
