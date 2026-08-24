import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { createCloudReadRouter } from "@/lib/sync/cloud-read-router.mjs";
import { getMultiDbSyncConfig } from "@/lib/sync/multi-config.mjs";
import { createProviderRegistry } from "@/lib/sync/providers/registry.mjs";
import { isAuthorizedGuild } from "@/lib/community-analytics-utils.mjs";
import { getManagedGuilds } from "@/lib/discord";
import { isRateLimited } from "@/lib/request-security";

const DISCORD_ID_PATTERN = /^\d{16,22}$/;
const PUBLIC_SNAPSHOT_TYPES = new Set(["guild_status", "analytics"]);

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (
    await isRateLimited(request, {
      scope: "cloud-analytics-snapshot",
      limit: 30,
      windowSeconds: 60,
      identity: session.user.id,
    })
  ) {
    return NextResponse.json({ error: "Too many snapshot requests" }, { status: 429 });
  }

  const searchParams = new URL(request.url).searchParams;
  const guildId = searchParams.get("guildId") ?? "";
  const snapshotType = searchParams.get("type") ?? "analytics";
  const requestedMaxAge = Number(searchParams.get("maxAgeSeconds") ?? 120);
  const maxAgeSeconds = Number.isFinite(requestedMaxAge)
    ? Math.min(900, Math.max(30, requestedMaxAge))
    : 120;
  const maxAgeMs = maxAgeSeconds * 1_000;
  if (!DISCORD_ID_PATTERN.test(guildId) || !PUBLIC_SNAPSHOT_TYPES.has(snapshotType)) {
    return NextResponse.json({ error: "Invalid snapshot request" }, { status: 400 });
  }
  const managedGuilds = await getManagedGuilds(session.user.id);
  if (!isAuthorizedGuild(managedGuilds, guildId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const config = getMultiDbSyncConfig(process.env);
  if (!config.webReadEnabled || !config.snapshotEnabled) {
    return NextResponse.json(
      { error: "Cloud snapshot reads are not enabled" },
      { status: 503 },
    );
  }

  const registry = await createProviderRegistry({ config });
  try {
    const router = createCloudReadRouter({ registry });
    const snapshot = await router.readSnapshot({
      snapshotType,
      aggregateId: guildId,
      maxAgeMs,
    });
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "private, max-age=15, must-revalidate" },
    });
  } catch {
    return NextResponse.json(
      { error: "Cloud analytics snapshot is temporarily unavailable" },
      { status: 503 },
    );
  } finally {
    await registry.close();
  }
}
