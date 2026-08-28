import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isAuthorizedGuild } from "@/lib/community-analytics-utils.mjs";
import { getManagedGuilds } from "@/lib/discord";
import { isRateLimited } from "@/lib/request-security";
import { analyticsCurrentProjectionKey } from "@/lib/sync/analytics-compaction.mjs";
import { withWebReadRouter } from "@/lib/web-analytics-read";

const DISCORD_ID_PATTERN = /^\d{16,22}$/;
const PUBLIC_SNAPSHOT_TYPES = new Set(["guild_status", "analytics"]);

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (await isRateLimited(request, {
    scope: "cloud-analytics-snapshot",
    limit: 30,
    windowSeconds: 60,
    identity: session.user.id,
  })) {
    return NextResponse.json({ error: "Too many snapshot requests" }, { status: 429 });
  }
  const searchParams = new URL(request.url).searchParams;
  const guildId = searchParams.get("guildId") ?? "";
  const snapshotType = searchParams.get("type") ?? "analytics";
  if (!DISCORD_ID_PATTERN.test(guildId) || !PUBLIC_SNAPSHOT_TYPES.has(snapshotType)) {
    return NextResponse.json({ error: "Invalid snapshot request" }, { status: 400 });
  }
  const managedGuilds = await getManagedGuilds(session.user.id);
  if (!isAuthorizedGuild(managedGuilds, guildId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const value = await withWebReadRouter(async (router) => {
      const aggregateId = snapshotType === "analytics"
        ? analyticsCurrentProjectionKey(guildId)
        : guildId;
      return router.readSnapshot({ snapshotType, aggregateId });
    });
    const configuredIntervalSeconds = Number(process.env.ANALYTICS_SNAPSHOT_INTERVAL_SECONDS || 900);
    const intervalMs = Number.isFinite(configuredIntervalSeconds)
      ? Math.min(86_400, Math.max(60, configuredIntervalSeconds)) * 1_000
      : 900_000;
    const nextUpdateAt = value.metadata.nextUpdateAt ?? Date.now() + intervalMs;
    return NextResponse.json({
      available: value.available,
      ...(value.snapshot ?? {}),
      readMeta: value.metadata,
      refreshSchedule: {
        lastUpdatedAt: value.metadata.lastUpdatedAt ?? 0,
        nextUpdateAt,
        intervalMs,
      },
    }, {
      headers: { "Cache-Control": "private, max-age=15, must-revalidate" },
    });
  } catch (error) {
    console.error("Projection snapshot API failed:", error);
    return NextResponse.json(
      { error: "Cloud analytics snapshot is temporarily unavailable" },
      { status: 503 },
    );
  }
}
