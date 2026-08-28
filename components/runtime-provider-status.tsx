"use client";

import { Cloud, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type ProviderStatus = {
  providerId: string;
  required: boolean;
  enabled: boolean;
  status: string;
  circuit: string;
  lastSuccessAt: number | null;
};

type RuntimeStatus = {
  overallStatus: string;
  lastSuccessfulSync: number | null;
  providers: ProviderStatus[];
};

function providerLabel(id: string) {
  if (id === "supabase") return "Supabase";
  if (id === "turso") return "Turso";
  if (id === "neon") return "Neon";
  return id;
}

export function RuntimeProviderStatus({ guildId, locale }: { guildId: string; locale: "ja" | "en" }) {
  const en = locale === "en";
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRequestAt = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!guildId || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/analytics/runtime?guildId=${encodeURIComponent(guildId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const value = await response.json();
      if (value?.runtime) setRuntime(value.runtime);
      lastRequestAt.current = Date.now();
    } catch {
      // Preserve the last successful operational snapshot. The card remains
      // degraded without causing the dashboard page to fail.
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    const onVisibility = () => {
      if (
        document.visibilityState === "visible"
        && Date.now() - lastRequestAt.current >= 60_000
      ) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const healthy = runtime?.overallStatus === "HEALTHY";
  return (
    <div className={`rounded-2xl border px-4 py-3.5 sm:px-5 ${healthy ? "border-emerald-400/25 bg-emerald-400/[0.07]" : "border-border bg-card/65"}`}>
      <div className={`flex items-center gap-2 text-xs font-bold ${healthy ? "text-emerald-400" : "text-muted-foreground"}`}>
        {loading && !runtime ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
        {en ? "CLOUD PROJECTIONS" : "CLOUD PROJECTION"}
      </div>
      <p className="mt-2 text-sm font-semibold">
        {runtime
          ? `${runtime.overallStatus} · ${runtime.providers.filter((provider) => provider.enabled).length} providers`
          : (en ? "Loading provider status" : "Provider状態を確認中")}
      </p>
      {runtime && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {runtime.providers.map((provider) => (
            <span key={provider.providerId} className="rounded-md bg-secondary/70 px-2 py-1 text-[10px] text-muted-foreground">
              {providerLabel(provider.providerId)}: {provider.enabled ? `${provider.status} / ${provider.circuit}` : "OFF"}
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        {runtime?.lastSuccessfulSync
          ? (en
              ? `All required replicas synced ${new Date(runtime.lastSuccessfulSync).toLocaleString("en-US")}`
              : `必須Replica同期: ${new Date(runtime.lastSuccessfulSync).toLocaleString("ja-JP")}`)
          : (en ? "Required replica sync is not yet confirmed" : "必須Replicaの同期時刻を確認できません")}
      </p>
    </div>
  );
}
