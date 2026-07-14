import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { isRateLimited } from '@/lib/request-security'

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function healthStatus(score: number, english: boolean) {
  if (score >= 75) return english ? 'Good' : '良好'
  if (score >= 45) return english ? 'Caution' : '注意'
  return english ? 'Needs attention' : '要確認'
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guildId = searchParams.get('guildId');
    const daysParam = Number(searchParams.get('days') ?? '14')
    const days = [7, 14, 30, 90, 150].includes(daysParam) ? daysParam : 14
    const english = searchParams.get('locale') === 'en'

    if (!guildId) {
      return NextResponse.json({ error: 'guildId is required' }, { status: 400 });
    }

    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (await isRateLimited(request, { scope: 'dashboard-status', limit: 60, windowSeconds: 60, identity: session.user.id })) {
      return NextResponse.json({ error: '取得回数が多すぎます。' }, { status: 429 })
    }

    const managedGuilds = await getManagedGuilds(session.user.id)
    if (!managedGuilds.some((guild) => guild.id === guildId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    
    // 📊 1. グラフ用の過去14日間のデータを取得
    const result = await pool.query<{ label: string; value: number; memberCount: number; reactionCount: number; activeMemberCount: number }>(`
      SELECT 
        to_char(stats.date, 'MM/DD') as label,
        stats."messageCount"::int as value,
        stats."memberCount"::int as "memberCount",
        stats."reactionCount"::int as "reactionCount",
        COALESCE(active."activeMemberCount", 0)::int as "activeMemberCount"
      FROM "daily_stats" stats
      LEFT JOIN (
        SELECT date, COUNT(*)::int AS "activeMemberCount"
        FROM "daily_active_member"
        WHERE "guildId" = $1 AND date >= CURRENT_DATE - ($2::int - 1)
        GROUP BY date
      ) active ON active.date = stats.date
      WHERE stats."guildId" = $1 AND stats.date >= CURRENT_DATE - ($2::int - 1)
      ORDER BY stats.date ASC
    `, [guildId, days])
    const rows = result.rows
    const messageTrendResult = await pool.query<{ label: string; value: number }>(`
      WITH dates AS (
        SELECT generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, interval '1 day')::date AS date
      )
      SELECT to_char(dates.date, 'MM/DD') AS label, COUNT(messages."id")::int AS value
      FROM dates
      LEFT JOIN "discord_message" AS messages
        ON messages."guildId" = $1
        AND messages."createdAt" >= dates.date
        AND messages."createdAt" < dates.date + interval '1 day'
      GROUP BY dates.date
      ORDER BY dates.date ASC
    `, [guildId, days])
    const messageTrend = messageTrendResult.rows
    const totalMessageResult = await pool.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM "discord_message" WHERE "guildId" = $1
    `, [guildId])
    const totalMessageCount = totalMessageResult.rows[0]?.count ?? 0
    const activityResult = await pool.query<{
      type: string
      actorName: string
      channelName: string | null
      occurredAt: Date
    }>(`
      SELECT "type", "actorName", "channelName", "occurredAt"
      FROM "recent_activity"
      WHERE "guildId" = $1
      ORDER BY "occurredAt" DESC
      LIMIT 5
    `, [guildId])
    const activeMemberResult = await pool.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM "daily_active_member"
      WHERE "guildId" = $1 AND date = CURRENT_DATE
    `, [guildId])
    const comparisonResult = await pool.query<{ previousMemberCount: number; previousActiveMemberCount: number; previousMessageCount: number; previousReactionRate: number }>(`
      SELECT
        COALESCE((
          SELECT "memberCount"::int
          FROM "daily_stats"
          WHERE "guildId" = $1 AND date <= CURRENT_DATE - $2::int
          ORDER BY date DESC
          LIMIT 1
        ), 0) AS "previousMemberCount",
        COALESCE((
          SELECT COUNT(*)::int
          FROM "daily_active_member"
          WHERE "guildId" = $1
            AND date >= CURRENT_DATE - ($2::int * 2 - 1)
          AND date <= CURRENT_DATE - $2::int
        ), 0) AS "previousActiveMemberCount",
        COALESCE((
          SELECT SUM("messageCount")::int
          FROM "daily_stats"
          WHERE "guildId" = $1
            AND date >= CURRENT_DATE - ($2::int * 2 - 1)
            AND date <= CURRENT_DATE - $2::int
        ), 0) AS "previousMessageCount",
        COALESCE((
          SELECT ROUND((SUM("reactionCount")::numeric / NULLIF(SUM("messageCount"), 0)) * 100, 1)
          FROM "daily_stats"
          WHERE "guildId" = $1
            AND date >= CURRENT_DATE - ($2::int * 2 - 1)
            AND date <= CURRENT_DATE - $2::int
        ), 0)::float AS "previousReactionRate"
    `, [guildId, days])
    const comparison = comparisonResult.rows[0] ?? { previousMemberCount: 0, previousActiveMemberCount: 0, previousMessageCount: 0, previousReactionRate: 0 }
    const historicalPreviousMessageResult = await pool.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count
      FROM "discord_message"
      WHERE "guildId" = $1
        AND "createdAt" >= CURRENT_DATE - ($2::int * 2 - 1)
        AND "createdAt" < CURRENT_DATE - ($2::int - 1)
    `, [guildId, days])
    const trendResult = await pool.query<{ messageCount: number; memberCount: number }>(`
      SELECT "messageCount"::int AS "messageCount", "memberCount"::int AS "memberCount"
      FROM "daily_stats"
      WHERE "guildId" = $1 AND date >= CURRENT_DATE - 13
      ORDER BY date ASC
    `, [guildId])
    const membershipEventResult = await pool.query<{ type: string; count: number }>(`
      SELECT "type", COUNT(*)::int AS count
      FROM "recent_activity"
      WHERE "guildId" = $1 AND "occurredAt" >= now() - interval '7 days'
        AND "type" IN ('member_joined', 'member_left')
      GROUP BY "type"
    `, [guildId])
    const voiceResult = await pool.query<{ totalSeconds: number; maxSessionSeconds: number }>(`
      WITH "selected_sessions" AS (
        SELECT
          GREATEST("startedAt", now() - ($2::int * interval '1 day')) AS "startedAt",
          LEAST(COALESCE("endedAt", now()), now()) AS "endedAt"
        FROM "voice_server_session"
        WHERE "guildId" = $1
          AND "startedAt" < now()
          AND ("endedAt" IS NULL OR "endedAt" > now() - ($2::int * interval '1 day'))
      )
      SELECT
        COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))), 0)::int AS "totalSeconds",
        COALESCE(MAX(GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))), 0)::int AS "maxSessionSeconds"
      FROM "selected_sessions"
    `, [guildId, days])
    const voice = voiceResult.rows[0] ?? { totalSeconds: 0, maxSessionSeconds: 0 }
    const previousVoiceResult = await pool.query<{ maxSessionSeconds: number }>(`
      WITH "previous_sessions" AS (
        SELECT
          GREATEST("startedAt", now() - ($2::int * 2 * interval '1 day')) AS "startedAt",
          LEAST(COALESCE("endedAt", now()), now() - ($2::int * interval '1 day')) AS "endedAt"
        FROM "voice_server_session"
        WHERE "guildId" = $1
          AND "startedAt" < now() - ($2::int * interval '1 day')
          AND ("endedAt" IS NULL OR "endedAt" > now() - ($2::int * 2 * interval '1 day'))
      )
      SELECT COALESCE(MAX(GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))), 0)::int AS "maxSessionSeconds"
      FROM "previous_sessions"
    `, [guildId, days])
    const previousMaxVoiceSessionSeconds = previousVoiceResult.rows[0]?.maxSessionSeconds ?? 0

    // 💡 まだデータがない場合の初期値
    if (rows.length === 0) {
      const today = new Date().toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' });
      return NextResponse.json({
        labels: messageTrend.map((row) => row.label),
        chartPoints: messageTrend.map((row) => row.value),
        memberPoints: messageTrend.map(() => 0),
        activeMemberPoints: messageTrend.map(() => 0),
        reactionPoints: messageTrend.map(() => 0),
        latestMemberCount: 0,  // カード用
        latestMessageCount: 0, // カード用
        totalMessageCount,
        activeMemberCount: activeMemberResult.rows[0]?.count ?? 0,
        previousMemberCount: comparison.previousMemberCount,
        previousActiveMemberCount: comparison.previousActiveMemberCount,
        periodMessageCount: messageTrend.reduce((sum, row) => sum + row.value, 0),
        periodReactionRate: 0,
        previousMessageCount: historicalPreviousMessageResult.rows[0]?.count ?? 0,
        previousReactionRate: comparison.previousReactionRate,
        previousMaxVoiceSessionSeconds,
        reactionRate: 0,
        voiceTotalSeconds: voice.totalSeconds,
        maxVoiceSessionSeconds: voice.maxSessionSeconds,
        health: { score: 0, status: english ? 'Collecting data' : 'データ収集中', activeLabel: english ? '0 members' : '0人', reactionLabel: '0.0%', conversationLabel: english ? 'Not enough data' : 'データ不足', retentionLabel: english ? 'Joined 0 / Left 0' : '参加 0 / 退出 0' },
        insight: { title: english ? 'Collecting data' : 'データを収集中です', body: english ? 'Growth insights will appear once the bot has recorded seven days of data.' : 'Botが7日間のデータを記録すると、実績に基づく成長インサイトを表示します。' },
        activities: activityResult.rows,
      });
    }

    // 💡 一番最後の行（＝最新の今日の日付のデータ）を取得
    const latestData = rows[rows.length - 1];

    const recentWeek = trendResult.rows.slice(-7)
    const previousWeek = trendResult.rows.slice(-14, -7)
    const recentMessages = recentWeek.reduce((sum, row) => sum + row.messageCount, 0)
    const previousMessages = previousWeek.reduce((sum, row) => sum + row.messageCount, 0)
    const memberDelta = latestData.memberCount - (previousWeek.at(-1)?.memberCount ?? latestData.memberCount)
    const messageDelta = previousMessages > 0 ? Math.round(((recentMessages - previousMessages) / previousMessages) * 100) : 0
    const activeMemberCount = activeMemberResult.rows[0]?.count ?? 0
    const periodMessageCount = messageTrend.reduce((sum, row) => sum + row.value, 0)
    const livePeriodMessageCount = rows.reduce((sum, row) => sum + row.value, 0)
    const periodReactionCount = rows.reduce((sum, row) => sum + row.reactionCount, 0)
    const periodReactionRate = livePeriodMessageCount > 0 ? Math.round((periodReactionCount / livePeriodMessageCount) * 1000) / 10 : 0
    const reactionRate = latestData.value > 0 ? Math.round((latestData.reactionCount / latestData.value) * 1000) / 10 : 0
    const joined = membershipEventResult.rows.find((row) => row.type === 'member_joined')?.count ?? 0
    const left = membershipEventResult.rows.find((row) => row.type === 'member_left')?.count ?? 0
    const activeRate = latestData.memberCount > 0 ? (activeMemberCount / latestData.memberCount) * 100 : 0
    const activeScore = clamp(activeRate * 10)
    const reactionScore = clamp(reactionRate * 5)
    const conversationScore = previousMessages > 0 ? clamp(50 + messageDelta) : (recentMessages > 0 ? 60 : 0)
    const retentionScore = joined + left > 0 ? clamp(50 + ((joined - left) / (joined + left)) * 50) : 60
    const healthScore = clamp(activeScore * 0.35 + reactionScore * 0.25 + conversationScore * 0.25 + retentionScore * 0.15)
    const health = {
      score: healthScore,
      status: healthStatus(healthScore, english),
      activeLabel: english ? `${activeMemberCount.toLocaleString()} members (${activeRate.toFixed(1)}%)` : `${activeMemberCount.toLocaleString()}人 (${activeRate.toFixed(1)}%)`,
      reactionLabel: `${reactionRate.toFixed(1)}%`,
      conversationLabel: previousMessages > 0 ? (english ? `vs. previous week ${messageDelta >= 0 ? '+' : ''}${messageDelta}%` : `前週比 ${messageDelta >= 0 ? '+' : ''}${messageDelta}%`) : (english ? 'Not enough comparison data' : '比較データ不足'),
      retentionLabel: english ? `Joined ${joined} / Left ${left}` : `参加 ${joined} / 退出 ${left}`,
    }
    const insight = previousWeek.length < 3
      ? { title: english ? 'Collecting data' : 'データを収集中です', body: english ? 'Growth insights will appear once the bot has recorded a little more data.' : 'Botがもう少しデータを記録すると、実績に基づく成長インサイトを表示します。' }
      : memberDelta > 0
        ? { title: english ? `${memberDelta} new members` : `メンバーが${memberDelta}人増加`, body: english ? `Messages over the last 7 days are ${messageDelta >= 0 ? '+' : ''}${messageDelta}% versus the previous week.` : `直近7日間のメッセージ数は前週比${messageDelta >= 0 ? '+' : ''}${messageDelta}%です。` }
        : { title: english ? `Conversation volume ${messageDelta >= 0 ? '+' : ''}${messageDelta}%` : `会話量は前週比${messageDelta >= 0 ? '+' : ''}${messageDelta}%`, body: english ? `${recentMessages.toLocaleString()} messages were recorded in the last 7 days.` : `直近7日間に${recentMessages.toLocaleString()}件のメッセージが記録されました。` }

    return NextResponse.json({
      labels: messageTrend.map(r => r.label),
      chartPoints: messageTrend.map(r => r.value),
      memberPoints: rows.map(r => r.memberCount),
      activeMemberPoints: rows.map(r => r.activeMemberCount),
      reactionPoints: rows.map(r => r.value > 0 ? Math.round((r.reactionCount / r.value) * 1000) / 10 : 0),
      latestMemberCount: latestData.memberCount, // ✨最新の総人数（カード用）
      latestMessageCount: latestData.value,      // ✨最新のメッセージ数（カード用）
      totalMessageCount,
      activeMemberCount,
      previousMemberCount: comparison.previousMemberCount,
      previousActiveMemberCount: comparison.previousActiveMemberCount,
      periodMessageCount,
      periodReactionRate,
      previousMessageCount: historicalPreviousMessageResult.rows[0]?.count ?? 0,
      previousReactionRate: comparison.previousReactionRate,
      previousMaxVoiceSessionSeconds,
      reactionRate,
      voiceTotalSeconds: voice.totalSeconds,
      maxVoiceSessionSeconds: voice.maxSessionSeconds,
      health,
      insight,
      activities: activityResult.rows,
    });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

