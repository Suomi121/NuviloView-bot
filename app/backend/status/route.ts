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

type InsightCard = {
  kind: 'channel' | 'time' | 'members' | 'engagement'
  title: string
  body: string
}

type ChannelInsight = {
  channelName: string
  messageCount: number
  previousMessageCount: number
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guildId = searchParams.get('guildId');
    const daysParam = Number(searchParams.get('days') ?? '14')
    const days = [7, 14, 30, 90, 150].includes(daysParam) ? daysParam : 14
    const english = searchParams.get('locale') === 'en'
    const requestedTimeZone = searchParams.get('timeZone') ?? 'Asia/Tokyo'
    const timeZone = Intl.supportedValuesOf('timeZone').includes(requestedTimeZone)
      ? requestedTimeZone
      : 'Asia/Tokyo'

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
    const botStatusResult = await pool.query<{
      lastRecordedAt: Date | null
      lastPermissionCheckAt: Date | null
      unreadableChannelCount: number
      unreadableChannelNames: string[] | null
    }>(`
      SELECT
        (
          SELECT MAX("updatedAt")
          FROM "daily_stats"
          WHERE "guildId" = $1
        ) AS "lastRecordedAt",
        (
          SELECT MAX("checkedAt")
          FROM "bot_channel_access"
          WHERE "guildId" = $1
        ) AS "lastPermissionCheckAt",
        COALESCE((
          SELECT COUNT(*)::int
          FROM "bot_channel_access"
          WHERE "guildId" = $1 AND "canRead" = false
        ), 0)::int AS "unreadableChannelCount",
        COALESCE((
          SELECT ARRAY_AGG("channelName" ORDER BY "channelName")
          FROM "bot_channel_access"
          WHERE "guildId" = $1 AND "canRead" = false
        ), ARRAY[]::text[]) AS "unreadableChannelNames"
    `, [guildId])
    const botStatus = botStatusResult.rows[0] ?? {
      lastRecordedAt: null,
      lastPermissionCheckAt: null,
      unreadableChannelCount: 0,
      unreadableChannelNames: [],
    }
    const messageTrendResult = await pool.query<{ label: string; value: number }>(`
      WITH dates AS (
        SELECT generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, interval '1 day')::date AS date
      ), stored_messages AS (
        SELECT "createdAt"::date AS date, COUNT("id")::int AS value
        FROM "discord_message"
        WHERE "guildId" = $1
          AND "createdAt" >= CURRENT_DATE - ($2::int - 1)
        GROUP BY "createdAt"::date
      )
      SELECT
        to_char(dates.date, 'MM/DD') AS label,
        GREATEST(
          COALESCE(stats."messageCount", 0),
          COALESCE(stored_messages.value, 0)
        )::int AS value
      FROM dates
      LEFT JOIN "daily_stats" AS stats
        ON stats."guildId" = $1 AND stats.date = dates.date
      LEFT JOIN stored_messages ON stored_messages.date = dates.date
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
            AND date = CURRENT_DATE - 1
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
      WHERE "guildId" = $1 AND "occurredAt" >= now() - ($2::int * interval '1 day')
        AND "type" IN ('member_joined', 'member_left')
      GROUP BY "type"
    `, [guildId, days])
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
    const detailedInsightResult = await pool.query<{
      topChannel: string | null
      topChannelMessages: number
      peakHour: number | null
      peakHourMessages: number
    }>(`
      WITH filtered_messages AS (
        SELECT "channelName", "createdAt"
        FROM "discord_message"
        WHERE "guildId" = $1
          AND "createdAt" >= CURRENT_DATE - ($2::int - 1)
      ), top_channel AS (
        SELECT "channelName", COUNT(*)::int AS "messageCount"
        FROM filtered_messages
        GROUP BY "channelName"
        ORDER BY "messageCount" DESC, "channelName" ASC
        LIMIT 1
      ), peak_hour AS (
        SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE $3)::int AS hour, COUNT(*)::int AS "messageCount"
        FROM filtered_messages
        GROUP BY hour
        ORDER BY "messageCount" DESC, hour ASC
        LIMIT 1
      )
      SELECT
        (SELECT "channelName" FROM top_channel) AS "topChannel",
        COALESCE((SELECT "messageCount" FROM top_channel), 0)::int AS "topChannelMessages",
        (SELECT hour FROM peak_hour) AS "peakHour",
        COALESCE((SELECT "messageCount" FROM peak_hour), 0)::int AS "peakHourMessages"
    `, [guildId, days, timeZone])
    const detailedInsight = detailedInsightResult.rows[0] ?? {
      topChannel: null,
      topChannelMessages: 0,
      peakHour: null,
      peakHourMessages: 0,
    }
    const channelInsightResult = await pool.query<ChannelInsight>(`
      WITH channel_names AS (
        SELECT DISTINCT "channelName" FROM "bot_channel_access"
        WHERE "guildId" = $1 AND "canRead" = true
        UNION
        SELECT DISTINCT "channelName" FROM "discord_message" WHERE "guildId" = $1
      ), counts AS (
        SELECT
          names."channelName",
          COUNT(messages."id") FILTER (WHERE messages."createdAt" >= now() - ($2::int * interval '1 day'))::int AS "messageCount",
          COUNT(messages."id") FILTER (
            WHERE messages."createdAt" >= now() - ($2::int * 2 * interval '1 day')
              AND messages."createdAt" < now() - ($2::int * interval '1 day')
          )::int AS "previousMessageCount"
        FROM channel_names names
        LEFT JOIN "discord_message" messages
          ON messages."guildId" = $1 AND messages."channelName" = names."channelName"
        GROUP BY names."channelName"
      )
      SELECT "channelName", COALESCE("messageCount", 0)::int AS "messageCount", COALESCE("previousMessageCount", 0)::int AS "previousMessageCount"
      FROM counts
      ORDER BY "messageCount" DESC, "channelName" ASC
      LIMIT 20
    `, [guildId, days])
    const channelInsights = channelInsightResult.rows.map((row) => ({
      channelName: row.channelName,
      messageCount: Number(row.messageCount ?? 0),
      previousMessageCount: Number(row.previousMessageCount ?? 0),
    }))
    const coverage = {
      statsDays: rows.length,
      messageDays: messageTrend.filter((row) => Number(row.value) > 0).length,
      insightRequiredDays: 10,
      insightRemainingDays: Math.max(0, 10 - rows.length),
    }

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
        latestMessageCount: messageTrend.at(-1)?.value ?? 0, // カード用
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
        insightCards: [
          { kind: 'channel', title: english ? 'Top channel' : '最も会話された場所', body: english ? 'Waiting for stored messages.' : '保存済みメッセージを待っています。' },
          { kind: 'time', title: english ? 'Peak time' : '会話が集中する時間帯', body: english ? 'Waiting for stored messages.' : '保存済みメッセージを待っています。' },
          { kind: 'members', title: english ? 'Member flow' : 'メンバーの増減', body: english ? 'Waiting for activity records.' : '参加・退出の記録を待っています。' },
        ] satisfies InsightCard[],
        channelInsights,
        coverage,
        activities: activityResult.rows,
        botStatus,
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
    const netMembers = joined - left
    const periodName = english ? `last ${days} days` : `過去${days}日間`
    const peakHour = detailedInsight.peakHour
    const nextHour = peakHour === null ? null : (peakHour + 1) % 24
    const reactionDelta = periodReactionRate - Number(comparison.previousReactionRate ?? 0)
    const insightCards: InsightCard[] = [
      detailedInsight.topChannel && detailedInsight.topChannelMessages > 0
        ? {
            kind: 'channel',
            title: english ? 'Most active channel' : '最も会話された場所',
            body: english
              ? `#${detailedInsight.topChannel} · ${detailedInsight.topChannelMessages.toLocaleString()} stored messages (${periodName})`
              : `#${detailedInsight.topChannel} · 保存済み${detailedInsight.topChannelMessages.toLocaleString()}件（${periodName}）`,
          }
        : {
            kind: 'channel',
            title: english ? 'Most active channel' : '最も会話された場所',
            body: english ? 'Messages will appear after the bot records them.' : 'Botがメッセージを記録すると表示されます。',
          },
      peakHour !== null && nextHour !== null && detailedInsight.peakHourMessages > 0
        ? {
            kind: 'time',
            title: english ? 'Peak conversation time' : '会話が集中する時間帯',
            body: english
              ? `${String(peakHour).padStart(2, '0')}:00–${String(nextHour).padStart(2, '0')}:00 · ${detailedInsight.peakHourMessages.toLocaleString()} stored messages`
              : `${String(peakHour).padStart(2, '0')}:00〜${String(nextHour).padStart(2, '0')}:00 · 保存済み${detailedInsight.peakHourMessages.toLocaleString()}件`,
          }
        : {
            kind: 'time',
            title: english ? 'Peak conversation time' : '会話が集中する時間帯',
            body: english ? 'More message history is needed.' : 'もう少しメッセージ履歴が必要です。',
          },
      joined + left > 0
        ? {
            kind: 'members',
            title: english ? 'Member flow' : 'メンバーの増減',
            body: english
              ? `${joined} joined · ${left} left · net ${netMembers >= 0 ? '+' : ''}${netMembers} (${periodName})`
              : `${joined}人参加 · ${left}人退出 · 純増${netMembers >= 0 ? '+' : ''}${netMembers}人（${periodName}）`,
          }
        : {
            kind: 'engagement',
            title: english ? 'Reaction engagement' : 'リアクションによる反応',
            body: english
              ? `${periodReactionRate.toFixed(1)}% average · ${reactionDelta >= 0 ? '+' : ''}${reactionDelta.toFixed(1)}pt vs. previous period`
              : `平均${periodReactionRate.toFixed(1)}% · 前期間比${reactionDelta >= 0 ? '+' : ''}${reactionDelta.toFixed(1)}pt`,
          },
    ]
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
      latestMessageCount: messageTrend.at(-1)?.value ?? latestData.value, // 今日の日次推移と同じ集計値
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
      insightCards,
      channelInsights,
      coverage,
      activities: activityResult.rows,
      botStatus,
    });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
