import { notFound } from 'next/navigation'
import { Coffee, Hash, MessageSquareText, Users } from 'lucide-react'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours}時間${minutes ? `${minutes}分` : ''}` : `${minutes}分`
}

export default async function PublicReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!/^[a-f0-9]{18}$/i.test(slug)) notFound()
  const report = await pool.query<{
    guildId: string; description: string; showMembers: boolean; showMessages: boolean; showVoice: boolean; showChannels: boolean; name: string | null; iconUrl: string | null
  }>(`
    SELECT report."guildId", report."description", report."showMembers", report."showMessages", report."showVoice", report."showChannels", registry."name", registry."iconUrl"
    FROM "guild_public_report" report
    LEFT JOIN "bot_guild_registry" registry ON registry."guildId" = report."guildId"
    WHERE report."slug"=$1 AND report."enabled"=true
    LIMIT 1
  `, [slug])
  const data = report.rows[0]
  if (!data) notFound()
  const metrics = await pool.query<{ members: number; messages: number; voiceSeconds: number }>(`
    WITH voice AS (
      SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE("endedAt", now()), now()) - GREATEST("startedAt", now() - interval '30 days'))))), 0)::int AS seconds
      FROM "voice_server_session" WHERE "guildId"=$1 AND "startedAt" >= now() - interval '30 days'
    ) SELECT
      COALESCE((SELECT "memberCount"::int FROM "daily_stats" WHERE "guildId"=$1 ORDER BY date DESC LIMIT 1), 0)::int AS members,
      COALESCE((SELECT SUM("messageCount")::int FROM "daily_stats" WHERE "guildId"=$1 AND date >= CURRENT_DATE - 29), 0)::int AS messages,
      (SELECT seconds FROM voice)::int AS "voiceSeconds"
  `, [data.guildId])
  const channels = data.showChannels ? await pool.query<{ channelName: string; count: number }>(`
    SELECT "channelName", COUNT(*)::int AS count FROM "discord_message"
    WHERE "guildId"=$1 AND "createdAt" >= now() - interval '30 days'
    GROUP BY "channelName" ORDER BY count DESC, "channelName" ASC LIMIT 3
  `, [data.guildId]) : { rows: [] }
  const values = metrics.rows[0] ?? { members: 0, messages: 0, voiceSeconds: 0 }
  const name = data.name ?? 'Discord Community'
  return <main className="min-h-screen bg-[#0d0d12] px-5 py-12 text-zinc-100 sm:px-8">
    <div className="mx-auto max-w-3xl">
      <a href="/" className="inline-flex items-center gap-2 text-sm font-bold text-[#818cff]"><Coffee className="h-4 w-4" />NuviloView<span className="text-white">:OEM</span></a>
      <section className="mt-8 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[#1c1d2d] to-[#111116] p-7 shadow-2xl sm:p-10">
        <div className="flex items-center gap-4">
          {data.iconUrl ? <img src={data.iconUrl} alt="" className="h-16 w-16 rounded-2xl object-cover" /> : <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#6677ff] text-2xl font-black">{name.slice(0, 1)}</div>}
          <div><p className="text-xs font-bold tracking-[.16em] text-[#9ba4ff]">PUBLIC SERVER REPORT</p><h1 className="mt-1 text-2xl font-black sm:text-3xl">{name}</h1></div>
        </div>
        {data.description && <p className="mt-6 max-w-2xl leading-relaxed text-zinc-300">{data.description}</p>}
        <p className="mt-4 text-xs text-zinc-500">過去30日間の、公開を許可された統計です。メッセージ本文・個人情報は表示しません。</p>
        <div className="mt-7 grid gap-3 sm:grid-cols-3">
          {data.showMembers && <Metric icon={<Users />} label="メンバー" value={`${values.members.toLocaleString()}人`} />}
          {data.showMessages && <Metric icon={<MessageSquareText />} label="30日間のメッセージ" value={`${values.messages.toLocaleString()}件`} />}
          {data.showVoice && <Metric icon={<Coffee />} label="30日間の通話" value={duration(values.voiceSeconds)} />}
        </div>
        {data.showChannels && <div className="mt-7 rounded-2xl border border-white/10 bg-black/15 p-5"><p className="flex items-center gap-2 text-sm font-bold"><Hash className="h-4 w-4 text-[#9ba4ff]" />よく利用されているチャンネル</p><div className="mt-4 space-y-3">{channels.rows.length ? channels.rows.map((channel) => <div key={channel.channelName} className="flex items-center justify-between text-sm"><span>#{channel.channelName}</span><span className="text-zinc-400">{channel.count.toLocaleString()}件</span></div>) : <p className="text-sm text-zinc-500">公開できるチャンネル統計はまだありません。</p>}</div></div>}
      </section>
      <p className="mt-6 text-center text-xs text-zinc-600">NuviloViewはDiscord公式サービスではありません。</p>
    </div>
  </main>
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-2xl border border-white/10 bg-black/15 p-4"><div className="flex items-center gap-2 text-xs font-bold text-[#9ba4ff]">{icon}{label}</div><p className="mt-3 text-xl font-black">{value}</p></div>
}
