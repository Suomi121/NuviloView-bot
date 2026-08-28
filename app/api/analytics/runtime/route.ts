import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isAuthorizedGuild } from "@/lib/community-analytics-utils.mjs";
import { getManagedGuilds } from "@/lib/discord";
import { isRateLimited } from "@/lib/request-security";
import { buildRuntimeReadModel } from "@/lib/runtime-read-model.mjs";
import { withWebReadRouter } from "@/lib/web-analytics-read";

const DISCORD_ID_PATTERN = /^\d{16,22}$/;

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (await isRateLimited(request, {
    scope: "analytics-runtime-status",
    limit: 30,
    windowSeconds: 60,
    identity: session.user.id,
  })) {
    return NextResponse.json({ error: "Too many runtime status requests" }, { status: 429 });
  }
  const guildId = new URL(request.url).searchParams.get("guildId") ?? "";
  if (!DISCORD_ID_PATTERN.test(guildId)) {
    return NextResponse.json({ error: "Invalid Guild ID" }, { status: 400 });
  }
  const managedGuilds = await getManagedGuilds(session.user.id);
  if (!isAuthorizedGuild(managedGuilds, guildId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const result = await withWebReadRouter(async (router) => {
      const [runtimeRead, syncRead] = await Promise.all([
        router.readRuntimeSnapshot(),
        router.readSyncStatusSnapshot(),
      ]);
      return {
        runtime: buildRuntimeReadModel({ runtimeRead, syncRead }),
        readMetrics: router.getMetrics(),
      };
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, max-age=30, must-revalidate" },
    });
  } catch (error) {
    console.error("Projection runtime status API failed:", error);
    return NextResponse.json(
      { error: "Runtime status is temporarily unavailable" },
      { status: 503 },
    );
  }
}
