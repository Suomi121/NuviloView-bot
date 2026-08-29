"use client";

import { Clock3 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAnalyticsRefreshDue,
  type AnalyticsRefreshReason,
  type AnalyticsRefreshSchedule,
} from "@/lib/analytics-refresh.mjs";

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
  schedule,
  locale,
  onRefresh,
}: {
  schedule: AnalyticsRefreshSchedule | null;
  locale: "ja" | "en";
  onRefresh?: (reason: AnalyticsRefreshReason) => Promise<boolean>;
}) {
  const [clock, setClock] = useState(() => Date.now());
  const [deferredNextUpdateAt, setDeferredNextUpdateAt] = useState<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const lastRequestedNextUpdateAtRef = useRef<number | null>(null);

  const nextUpdateAt = deferredNextUpdateAt ?? schedule?.nextUpdateAt ?? null;

  useEffect(() => {
    setDeferredNextUpdateAt(null);
    lastRequestedNextUpdateAtRef.current = null;
    setClock(Date.now());
  }, [schedule?.nextUpdateAt]);

  const requestRefresh = useCallback(async (reason: AnalyticsRefreshReason) => {
    if (!schedule || !onRefresh || nextUpdateAt === null) return false;
    const at = Date.now();
    if (!isAnalyticsRefreshDue({
      at,
      nextUpdateAt,
      inFlight: refreshInFlightRef.current,
      lastRequestedNextUpdateAt: lastRequestedNextUpdateAtRef.current,
    })) return false;

    refreshInFlightRef.current = true;
    lastRequestedNextUpdateAtRef.current = nextUpdateAt;
    try {
      const refreshed = await onRefresh(reason);
      if (!refreshed) {
        // A failed request is deferred to the next projection window. This
        // prevents a deadline or visibility event from creating a retry storm.
        setDeferredNextUpdateAt(Date.now() + schedule.intervalMs);
      }
      return refreshed;
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [nextUpdateAt, onRefresh, schedule]);

  useEffect(() => {
    if (!schedule || nextUpdateAt === null) return;
    // This interval updates only the browser text. It never calls an API.
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    const refreshTimer = onRefresh
      ? window.setTimeout(
          () => void requestRefresh("countdown"),
          Math.max(250, nextUpdateAt - Date.now()),
        )
      : null;
    const onVisibility = () => {
      if (
        onRefresh
        && document.visibilityState === "visible"
        && Date.now() >= nextUpdateAt
      ) {
        void requestRefresh("visibility");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(clockTimer);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [nextUpdateAt, onRefresh, requestRefresh, schedule]);

  if (!schedule || nextUpdateAt === null) return null;
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
        {en ? "Next in" : "次回更新まで"} {remainingLabel(nextUpdateAt - clock)}
      </span>
    </div>
  );
}
