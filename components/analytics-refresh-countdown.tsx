"use client";

import { Clock3 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type RefreshSchedule = {
  lastUpdatedAt: number;
  nextUpdateAt: number;
  intervalMs: number;
};

function remainingLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function AnalyticsRefreshCountdown({
  guildId,
  locale,
  onRefresh,
}: {
  guildId: string;
  locale: "ja" | "en";
  onRefresh?: () => void;
}) {
  const [schedule, setSchedule] = useState<RefreshSchedule | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const requestRef = useRef<AbortController | null>(null);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const load = useCallback(async (refreshAnalytics = false) => {
    if (!guildId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch(
        `/api/analytics/snapshot?guildId=${encodeURIComponent(guildId)}&type=analytics&maxAgeSeconds=900`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) return;
      const value = await response.json();
      const next = value?.refreshSchedule;
      if (
        Number.isFinite(Number(next?.lastUpdatedAt)) &&
        Number.isFinite(Number(next?.nextUpdateAt))
      ) {
        setSchedule({
          lastUpdatedAt: Number(next.lastUpdatedAt),
          nextUpdateAt: Number(next.nextUpdateAt),
          intervalMs: Number(next.intervalMs),
        });
        setClock(Date.now());
        if (refreshAnalytics) onRefreshRef.current?.();
      }
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError") {
        // The detailed analytics view remains usable when Cloud snapshots are
        // temporarily unavailable. Retry only at the next projection window,
        // never with a short polling loop.
        setSchedule((current) => {
          const intervalMs = current?.intervalMs || 15 * 60_000;
          return {
            lastUpdatedAt: current?.lastUpdatedAt ?? 0,
            nextUpdateAt: Date.now() + intervalMs,
            intervalMs,
          };
        });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [guildId]);

  useEffect(() => {
    setSchedule(null);
    void load(false);
    return () => requestRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!schedule) return;
    // This interval updates only the browser text. It never calls an API.
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    const refreshTimer = window.setTimeout(
      () => void load(true),
      Math.max(250, schedule.nextUpdateAt - Date.now()),
    );
    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() >= schedule.nextUpdateAt
      ) {
        void load(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(clockTimer);
      window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, schedule]);

  if (!schedule) return null;
  const en = locale === "en";
  const updated = schedule.lastUpdatedAt > 0
    ? new Intl.DateTimeFormat(en ? "en-US" : "ja-JP", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(schedule.lastUpdatedAt)
    : null;
  return (
    <div className="ml-auto flex items-center gap-2 rounded-lg border border-border bg-secondary/55 px-3 py-2 text-[11px] font-semibold text-muted-foreground">
      <Clock3 className="h-3.5 w-3.5 text-primary" />
      <span>
        {updated
          ? (en ? `Updated ${updated}` : `最終更新 ${updated}`)
          : (en ? "Snapshot pending" : "集約データ待ち")}
      </span>
      <span aria-label={en ? "Time until the next analytics refresh" : "次回分析更新まで"}>
        {en ? "Next in" : "次回更新まで"} {remainingLabel(schedule.nextUpdateAt - clock)}
      </span>
    </div>
  );
}
