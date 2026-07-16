import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getManagedGuilds } from "@/lib/discord";
import {
  hasJsonBody,
  isRateLimited,
  isTrustedMutation,
} from "@/lib/request-security";

const allowedDays = [7, 30, 90] as const;

async function mayManageGuild(userId: string, guildId: string) {
  const guilds = await getManagedGuilds(userId);
  return guilds.some((guild) => guild.id === guildId);
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guildId = new URL(request.url).searchParams.get("guildId");
  if (!guildId)
    return NextResponse.json({ error: "guildId is required" }, { status: 400 });
  if (!(await mayManageGuild(session.user.id, guildId)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = await pool.query(
    `SELECT "id", "days", "mode", "status", "processedMessages", "failedChannels", "requestedAt", "startedAt", "completedAt", "error" FROM "history_import_job" WHERE "guildId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`,
    [guildId],
  );
  return NextResponse.json({ job: result.rows[0] ?? null });
}

export async function POST(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 1_024))
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (
    await isRateLimited(request, {
      scope: "history-import",
      limit: 3,
      windowSeconds: 60 * 60,
      identity: session.user.id,
      failClosed: true,
    })
  )
    return NextResponse.json(
      {
        error:
          "インポートの開始回数が多すぎます。しばらく待ってからお試しください。",
      },
      { status: 429 },
    );

  const body = await request.json().catch(() => null);
  const guildId = typeof body?.guildId === "string" ? body.guildId : "";
  const days = Number(body?.days);
  const mode = body?.mode === "developer" ? "developer" : "standard";
  if (!guildId || !allowedDays.includes(days as (typeof allowedDays)[number]))
    return NextResponse.json(
      { error: "Invalid import options" },
      { status: 400 },
    );
  if (!(await mayManageGuild(session.user.id, guildId)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const result = await pool.query(
      `INSERT INTO "history_import_job" ("guildId", "requestedBy", "days", "mode") VALUES ($1, $2, $3, $4) RETURNING "id", "days", "mode", "status", "processedMessages", "failedChannels", "requestedAt"`,
      [guildId, session.user.id, days, mode],
    );
    return NextResponse.json({ job: result.rows[0] }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      return NextResponse.json(
        { error: "このサーバーではすでに履歴インポートを実行中です。" },
        { status: 409 },
      );
    console.error("Failed to create history import job:", error);
    return NextResponse.json(
      { error: "Unable to start import" },
      { status: 500 },
    );
  }
}
