import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getCommunityAnalytics, type AnalyticsRange } from "@/lib/community-analytics";
import { isAuthorizedGuild } from "@/lib/community-analytics-utils.mjs";
import { pool } from "@/lib/db";
import { getManagedGuilds } from "@/lib/discord";
import { isRateLimited } from "@/lib/request-security";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DISCORD_ID_PATTERN = /^\d{16,22}$/;

function dateInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dayCount(startDate: string, endDate: string) {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function parseRange(searchParams: URLSearchParams): AnalyticsRange | null {
  const requestedTimeZone = searchParams.get("timeZone") ?? "Asia/Tokyo";
  const timeZone = Intl.supportedValuesOf("timeZone").includes(requestedTimeZone) ? requestedTimeZone : "Asia/Tokyo";
  const customStart = searchParams.get("startDate");
  const customEnd = searchParams.get("endDate");
  const today = dateInTimeZone(timeZone);
  let startDate: string;
  let endDate: string;
  let days: number;
  if (customStart || customEnd) {
    if (!customStart || !customEnd || !DATE_PATTERN.test(customStart) || !DATE_PATTERN.test(customEnd)) return null;
    days = dayCount(customStart, customEnd);
    if (days < 1 || days > 365) return null;
    startDate = customStart;
    endDate = customEnd;
  } else {
    const requestedDays = Number(searchParams.get("days") ?? 30);
    days = [7, 14, 30, 90, 150].includes(requestedDays) ? requestedDays : 30;
    endDate = today;
    startDate = addDays(endDate, -(days - 1));
  }
  const previousEndDate = addDays(startDate, -1);
  const previousStartDate = addDays(previousEndDate, -(days - 1));
  const roleId = searchParams.get("roleId") || null;
  const channelId = searchParams.get("channelId") || null;
  if ((roleId && !DISCORD_ID_PATTERN.test(roleId)) || (channelId && !DISCORD_ID_PATTERN.test(channelId))) return null;
  return {
    startDate, endDate, previousStartDate, previousEndDate, days, timeZone, roleId, channelId,
    excludeBots: searchParams.get("excludeBots") !== "false",
  };
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (await isRateLimited(request, { scope: "community-analytics", limit: 20, windowSeconds: 60, identity: session.user.id })) {
      return NextResponse.json({ error: "Too many analytics requests" }, { status: 429 });
    }
    const searchParams = new URL(request.url).searchParams;
    const guildId = searchParams.get("guildId") ?? "";
    const range = parseRange(searchParams);
    if (!DISCORD_ID_PATTERN.test(guildId) || !range) {
      return NextResponse.json({ error: "Invalid analytics filters" }, { status: 400 });
    }
    const managedGuilds = await getManagedGuilds(session.user.id);
    if (!isAuthorizedGuild(managedGuilds, guildId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (range.channelId || range.roleId) {
      const ownership = await pool.query<{ channelExists: boolean; roleExists: boolean }>(`
        SELECT
          CASE WHEN $2::text IS NULL THEN true ELSE EXISTS (SELECT 1 FROM "guild_channel_registry" WHERE "guildId" = $1 AND "channelId" = $2) END AS "channelExists",
          CASE WHEN $3::text IS NULL THEN true ELSE EXISTS (SELECT 1 FROM "guild_role_registry" WHERE "guildId" = $1 AND "roleId" = $3) END AS "roleExists"
      `, [guildId, range.channelId, range.roleId]);
      if (!ownership.rows[0]?.channelExists || !ownership.rows[0]?.roleExists) {
        return NextResponse.json({ error: "Filter does not belong to this server" }, { status: 403 });
      }
    }
    const analytics = await getCommunityAnalytics(guildId, range);
    return NextResponse.json(analytics, {
      headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
    });
  } catch (error) {
    console.error("Community analytics API failed:", error);
    return NextResponse.json({ error: "Analytics are temporarily unavailable" }, { status: 500 });
  }
}
