import { NextResponse } from "next/server";

import {
  createAnalyticsRefreshContract,
  getAnalyticsRefreshIntervalMs,
} from "@/lib/analytics-refresh.mjs";
import { auth } from "@/lib/auth";
import { isAuthorizedGuild } from "@/lib/community-analytics-utils.mjs";
import { getManagedGuilds } from "@/lib/discord";
import {
  buildProjectionDashboardStatus,
  type ProjectionAnalyticsRange,
} from "@/lib/projection-analytics";
import { isRateLimited } from "@/lib/request-security";
import { withWebReadRouter } from "@/lib/web-analytics-read";

const DISCORD_ID_PATTERN = /^\d{16,22}$/;

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function todayIn(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const guildId = searchParams.get("guildId") ?? "";
    const daysParam = Number(searchParams.get("days") ?? 14);
    const days = [7, 14, 30, 90, 150].includes(daysParam) ? daysParam : 14;
    const english = searchParams.get("locale") === "en";
    const requestedTimeZone = searchParams.get("timeZone") ?? "Asia/Tokyo";
    const timeZone = Intl.supportedValuesOf("timeZone").includes(requestedTimeZone)
      ? requestedTimeZone
      : "Asia/Tokyo";
    if (!DISCORD_ID_PATTERN.test(guildId)) {
      return NextResponse.json({ error: "guildId is required" }, { status: 400 });
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (await isRateLimited(request, {
      scope: "dashboard-status",
      limit: 60,
      windowSeconds: 60,
      identity: session.user.id,
    })) {
      return NextResponse.json({ error: "取得回数が多すぎます。" }, { status: 429 });
    }
    const managedGuilds = await getManagedGuilds(session.user.id);
    if (!isAuthorizedGuild(managedGuilds, guildId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const endDate = todayIn(timeZone);
    const startDate = addDays(endDate, -(days - 1));
    const previousEndDate = addDays(startDate, -1);
    const previousStartDate = addDays(previousEndDate, -(days - 1));
    const range: ProjectionAnalyticsRange = {
      startDate,
      endDate,
      previousStartDate,
      previousEndDate,
      days,
      timeZone,
      roleId: null,
      channelId: null,
      excludeBots: true,
    };
    const response = await withWebReadRouter(async (router) => {
      const bundle = await router.readAnalyticsBundle({
        guildId,
        dateFrom: previousStartDate,
        dateTo: endDate,
      });
      return buildProjectionDashboardStatus(bundle, range, english);
    });
    const refresh = createAnalyticsRefreshContract(response.readMeta, {
      intervalMs: getAnalyticsRefreshIntervalMs(process.env),
    });
    return NextResponse.json({ ...response, ...refresh }, {
      headers: { "Cache-Control": "private, max-age=15, must-revalidate" },
    });
  } catch (error) {
    console.error("Projection dashboard API failed:", error);
    return NextResponse.json(
      { error: "Analytics are temporarily unavailable" },
      { status: 503 },
    );
  }
}
