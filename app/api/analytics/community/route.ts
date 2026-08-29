import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  createAnalyticsRefreshContract,
  getAnalyticsRefreshIntervalMs,
} from "@/lib/analytics-refresh.mjs";
import { isAuthorizedGuild } from "@/lib/community-analytics-utils.mjs";
import { getManagedGuilds } from "@/lib/discord";
import {
  buildProjectionCommunityAnalytics,
  type ProjectionAnalyticsRange,
} from "@/lib/projection-analytics";
import { isRateLimited } from "@/lib/request-security";
import { withWebReadRouter } from "@/lib/web-analytics-read";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DISCORD_ID_PATTERN = /^\d{16,22}$/;

function dateInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dayCount(startDate: string, endDate: string) {
  return Math.floor(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`))
      / 86_400_000,
  ) + 1;
}

function parseRange(searchParams: URLSearchParams): ProjectionAnalyticsRange | null {
  const requestedTimeZone = searchParams.get("timeZone") ?? "Asia/Tokyo";
  const timeZone = Intl.supportedValuesOf("timeZone").includes(requestedTimeZone)
    ? requestedTimeZone
    : "Asia/Tokyo";
  const customStart = searchParams.get("startDate");
  const customEnd = searchParams.get("endDate");
  const today = dateInTimeZone(timeZone);
  let startDate: string;
  let endDate: string;
  let days: number;
  if (customStart || customEnd) {
    if (
      !customStart
      || !customEnd
      || !DATE_PATTERN.test(customStart)
      || !DATE_PATTERN.test(customEnd)
    ) return null;
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
  if (
    (roleId && !DISCORD_ID_PATTERN.test(roleId))
    || (channelId && !DISCORD_ID_PATTERN.test(channelId))
  ) return null;
  return {
    startDate,
    endDate,
    previousStartDate,
    previousEndDate,
    days,
    timeZone,
    roleId,
    channelId,
    excludeBots: searchParams.get("excludeBots") !== "false",
  };
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (await isRateLimited(request, {
      scope: "community-analytics",
      limit: 20,
      windowSeconds: 60,
      identity: session.user.id,
    })) {
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
    if (range.roleId) {
      return NextResponse.json(
        { error: "Role-filtered analytics are not available in Projection v1" },
        { status: 422 },
      );
    }
    const result = await withWebReadRouter(async (router) => {
      const bundle = await router.readAnalyticsBundle({
        guildId,
        dateFrom: range.previousStartDate,
        dateTo: range.endDate,
      });
      if (range.channelId && bundle.available) {
        const belongsToGuild = bundle.snapshots.some(
          (snapshot) => String(snapshot.payload?.channelId ?? "") === range.channelId,
        );
        if (!belongsToGuild) return { forbiddenFilter: true as const };
      }
      return {
        forbiddenFilter: false as const,
        analytics: buildProjectionCommunityAnalytics(bundle, range),
        metrics: router.getMetrics(),
      };
    });
    if (result.forbiddenFilter) {
      return NextResponse.json(
        { error: "Filter does not belong to this server" },
        { status: 403 },
      );
    }
    const refresh = createAnalyticsRefreshContract(result.analytics.readMeta, {
      intervalMs: getAnalyticsRefreshIntervalMs(process.env),
    });
    return NextResponse.json({
      ...result.analytics,
      ...refresh,
      readMetrics: result.metrics,
    }, {
      headers: { "Cache-Control": "private, max-age=15, must-revalidate" },
    });
  } catch (error) {
    console.error("Community Projection analytics API failed:", error);
    return NextResponse.json(
      { error: "Analytics are temporarily unavailable" },
      { status: 503 },
    );
  }
}
