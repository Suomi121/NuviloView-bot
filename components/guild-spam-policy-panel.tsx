"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import {
  getSpamPolicyPreset,
  withCustomPresetOnManualChange,
  type GuildSpamPolicy,
  type SpamAction,
  type SpamPreset,
} from "@/lib/guild-spam-policy.mjs";
import { createGuildSpamPolicyRequestGuard } from "@/lib/guild-spam-policy-request-guard.mjs";

type Guild = { id: string; name: string };
const clonePolicy = (policy: Readonly<GuildSpamPolicy>): GuildSpamPolicy => ({ ...policy, ignoredRoleIds: [...policy.ignoredRoleIds], ignoredChannelIds: [...policy.ignoredChannelIds] });

const numericFields = [
  { count: "messageCountThreshold", window: "messageWindowSeconds", key: "messages", unit: "messages" },
  { count: "duplicateCountThreshold", window: "duplicateWindowSeconds", key: "duplicates", unit: "repeats" },
  { count: "mentionCountThreshold", window: "mentionWindowSeconds", key: "mentions", unit: "mentions" },
  { count: "linkCountThreshold", window: "linkWindowSeconds", key: "links", unit: "links" },
  { count: "crossChannelThreshold", window: "crossChannelWindowSeconds", key: "crossChannel", unit: "channels" },
] as const;

export function GuildSpamPolicyPanel() {
  const { locale } = useLocale();
  const en = locale === "en";
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildId, setGuildId] = useState("");
  const [policy, setPolicy] = useState<GuildSpamPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<GuildSpamPolicy | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [loadingGuilds, setLoadingGuilds] = useState(true);
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [roleIdsText, setRoleIdsText] = useState("");
  const [channelIdsText, setChannelIdsText] = useState("");
  const requestGuardRef = useRef(createGuildSpamPolicyRequestGuard());
  const selectedGuildIdRef = useRef("");
  const policyLoadAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const guard = requestGuardRef.current;
    guard.mount();
    return () => {
      guard.unmount();
      policyLoadAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/guilds", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { if (active) setGuilds(Array.isArray(data.guilds) ? data.guilds : []); })
      .catch(() => { if (active) setStatus(en ? "Unable to load manageable servers." : "管理できるサーバーを読み込めませんでした。"); })
      .finally(() => { if (active) setLoadingGuilds(false); });
    return () => { active = false; };
  }, [en]);

  useEffect(() => {
    if (!guildId) {
      setPolicy(null); setSavedPolicy(null); setIsCustom(false); setLoadingPolicy(false); return;
    }
    const targetGuildId = guildId;
    const request = requestGuardRef.current.begin("load", targetGuildId);
    const controller = new AbortController();
    policyLoadAbortRef.current?.abort();
    policyLoadAbortRef.current = controller;
    setPolicy(null); setSavedPolicy(null); setLoadingPolicy(true); setStatus("");
    fetch(`/api/guilds/${encodeURIComponent(targetGuildId)}/security/spam-policy`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        if (!request.isCurrent() || !data.policy) return;
        const next = clonePolicy(data.policy);
        setPolicy(next); setSavedPolicy(clonePolicy(next)); setIsCustom(Boolean(data.isCustom));
        setRoleIdsText(next.ignoredRoleIds.join(", ")); setChannelIdsText(next.ignoredChannelIds.join(", "));
      })
      .catch(() => {
        if (request.isCurrent() && !controller.signal.aborted) setStatus(en ? "Unable to load this server's spam settings." : "このサーバーのスパム設定を読み込めませんでした。");
      })
      .finally(() => {
        if (request.isCurrent()) setLoadingPolicy(false);
        if (policyLoadAbortRef.current === controller) policyLoadAbortRef.current = null;
      });
    return () => { controller.abort(); };
  }, [guildId, en]);

  const draft = useMemo(() => policy ? ({ ...policy, ignoredRoleIds: roleIdsText.split(/[\s,]+/).filter(Boolean), ignoredChannelIds: channelIdsText.split(/[\s,]+/).filter(Boolean) }) : null, [policy, roleIdsText, channelIdsText]);
  const isDirty = Boolean(draft && savedPolicy && (!isCustom || JSON.stringify(draft) !== JSON.stringify(savedPolicy)));
  const setField = <K extends keyof GuildSpamPolicy>(key: K, value: GuildSpamPolicy[K]) => {
    setPolicy((current) => current ? withCustomPresetOnManualChange(current, key, value) : current);
    setStatus("");
  };

  const choosePreset = (preset: SpamPreset) => {
    setPolicy((current) => {
      if (!current) return current;
      if (preset === "CUSTOM") return { ...current, preset: "CUSTOM" };
      const values = getSpamPolicyPreset(preset);
      return values ? { ...current, ...values } : current;
    });
    setStatus("");
  };

  const selectGuild = (nextGuildId: string) => {
    selectedGuildIdRef.current = nextGuildId;
    requestGuardRef.current.selectGuild(nextGuildId);
    policyLoadAbortRef.current?.abort();
    policyLoadAbortRef.current = null;
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = null;
    setGuildId(nextGuildId);
    setPolicy(null); setSavedPolicy(null); setIsCustom(false); setLoadingPolicy(Boolean(nextGuildId));
    setSaving(false); setStatus(""); setRoleIdsText(""); setChannelIdsText("");
  };

  const save = async () => {
    const targetGuildId = selectedGuildIdRef.current;
    if (!targetGuildId || !draft) return;
    const request = requestGuardRef.current.begin("mutation", targetGuildId);
    const controller = new AbortController();
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = controller;
    const submittedPolicy = clonePolicy(draft);
    setSaving(true); setStatus("");
    try {
      const response = await fetch(`/api/guilds/${encodeURIComponent(targetGuildId)}/security/spam-policy`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: submittedPolicy }), signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.policy) throw new Error();
      if (!request.isCurrent() || selectedGuildIdRef.current !== targetGuildId) return;
      const next = clonePolicy(data.policy);
      setPolicy(next); setSavedPolicy(clonePolicy(next)); setIsCustom(true);
      setRoleIdsText(next.ignoredRoleIds.join(", ")); setChannelIdsText(next.ignoredChannelIds.join(", "));
      setStatus(en ? "Saved. The Bot refreshes this policy within 30 seconds." : "保存しました。Botには最大30秒以内に反映されます。");
    } catch {
      if (request.isCurrent() && selectedGuildIdRef.current === targetGuildId && !controller.signal.aborted) {
        setStatus(en ? "Could not save the spam settings. Please try again." : "スパム設定を保存できませんでした。時間をおいて再試行してください。");
      }
    } finally {
      if (request.isCurrent() && selectedGuildIdRef.current === targetGuildId) setSaving(false);
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
    }
  };

  const reset = async () => {
    const targetGuildId = selectedGuildIdRef.current;
    if (!targetGuildId) return;
    const request = requestGuardRef.current.begin("mutation", targetGuildId);
    const controller = new AbortController();
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = controller;
    setSaving(true); setStatus("");
    try {
      const response = await fetch(`/api/guilds/${encodeURIComponent(targetGuildId)}/security/spam-policy`, { method: "DELETE", signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.policy) throw new Error();
      if (!request.isCurrent() || selectedGuildIdRef.current !== targetGuildId) return;
      const next = clonePolicy(data.policy);
      setPolicy(next); setSavedPolicy(clonePolicy(next)); setIsCustom(false);
      setRoleIdsText(""); setChannelIdsText("");
      setStatus(en ? "Reset. This server uses the existing NuviloView default behavior." : "初期設定に戻しました。このサーバーでは従来のNuviloView既定動作を使用します。");
    } catch {
      if (request.isCurrent() && selectedGuildIdRef.current === targetGuildId && !controller.signal.aborted) {
        setStatus(en ? "Could not reset the spam settings. Please try again." : "初期設定に戻せませんでした。時間をおいて再試行してください。");
      }
    } finally {
      if (request.isCurrent() && selectedGuildIdRef.current === targetGuildId) setSaving(false);
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
    }
  };

  const labels = en
    ? { preset: "Preset", relaxed: "Relaxed", normal: "Normal", strict: "Strict", custom: "Custom", messages: "Messages", duplicates: "Duplicates", mentions: "Mentions", links: "Links", crossChannel: "Cross-channel", threshold: "Count", window: "Window", enabled: "Spam detection enabled", action: "After detection", log: "Log only", alert: "Alert moderators", incident: "Create incident + alert", ignoreBots: "Ignore other bots", ignoreAdmins: "Ignore owners and moderators", roles: "Ignored role IDs", channels: "Ignored channel IDs", choose: "Choose a server", loading: "Loading…", current: "Current", next: "New settings", reset: "Reset to default", save: "Save", noGuilds: "No manageable servers are available." }
    : { preset: "プリセット", relaxed: "ゆるめ", normal: "標準", strict: "厳しめ", custom: "カスタム", messages: "連続投稿", duplicates: "同一内容", mentions: "メンション", links: "リンク", crossChannel: "複数チャンネル", threshold: "件数", window: "時間", enabled: "スパム検知を有効にする", action: "検知後の動作", log: "記録のみ", alert: "管理者へ通知", incident: "インシデント記録＋通知", ignoreBots: "他のBotを除外", ignoreAdmins: "所有者・モデレーターを除外", roles: "除外するロールID", channels: "除外するチャンネルID", choose: "サーバーを選択", loading: "読み込み中…", current: "現在", next: "変更後", reset: "従来の既定動作へ戻す", save: "保存", noGuilds: "管理できるサーバーがありません。" };

  const describe = (value: GuildSpamPolicy | null) => value ? [
    `${en ? "Messages" : "連続投稿"} ${value.messageCountThreshold}/${value.messageWindowSeconds}s`,
    `${en ? "Duplicates" : "同一内容"} ${value.duplicateCountThreshold}/${value.duplicateWindowSeconds}s`,
    `${en ? "Mentions" : "メンション"} ${value.mentionCountThreshold}/${value.mentionWindowSeconds}s`,
    `${en ? "Links" : "リンク"} ${value.linkCountThreshold}/${value.linkWindowSeconds}s`,
    `${en ? "Channels" : "複数ch"} ${value.crossChannelThreshold}/${value.crossChannelWindowSeconds}s`,
    `${en ? "Action" : "対応"} ${value.action}`,
  ].join(" · ") : "—";

  return <section className="rounded-2xl border border-border bg-card/65 p-5 shadow-xl shadow-black/10 sm:p-7">
    <div className="flex items-start gap-3"><span className="rounded-xl bg-primary/15 p-2.5 text-primary"><ShieldAlert className="h-5 w-5" /></span><div><h2 className="text-lg font-extrabold">{en ? "Spam Detection" : "Spam Detection"}</h2><p className="mt-1 text-sm text-muted-foreground">{en ? "Set detection thresholds and response separately for each Discord server." : "Discordサーバーごとに、検知条件と検知後の対応を設定します。"}</p></div></div>
    <label className="mt-5 block text-sm font-semibold">{labels.choose}<select aria-label={labels.choose} disabled={loadingGuilds || !guilds.length} value={guildId} onChange={(event) => selectGuild(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm">{guilds.length ? <><option value="">{loadingGuilds ? labels.loading : labels.choose}</option>{guilds.map((guild) => <option value={guild.id} key={guild.id}>{guild.name}</option>)}</> : <option value="">{loadingGuilds ? labels.loading : labels.noGuilds}</option>}</select></label>
    {guildId && <>
      {loadingPolicy && <p className="mt-5 text-sm text-muted-foreground">{labels.loading}</p>}
      {policy && draft && <>
        {!isCustom && <p className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">{en ? "No custom policy is saved. The Bot's existing environment-based behavior remains active (code defaults: 3 messages / 5 seconds and a 5-minute timeout; environment overrides may apply). Saving below switches this server to the selected non-automatic action." : "個別設定は未保存です。従来のBot環境設定を維持します（コード既定は5秒以内に3件・5分タイムアウト。環境変数で上書きされる場合があります）。下記を保存すると、このサーバーでは選択した自動処分なしの動作に切り替わります。"}</p>}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3"><input type="checkbox" checked={policy.enabled} onChange={(event) => setField("enabled", event.target.checked)} /><span className="text-sm font-semibold">{labels.enabled}</span></label>
          <label className="text-sm font-semibold">{labels.preset}<select value={policy.preset} onChange={(event) => choosePreset(event.target.value as SpamPreset)} className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="RELAXED">{labels.relaxed}</option><option value="NORMAL">{labels.normal}</option><option value="STRICT">{labels.strict}</option><option value="CUSTOM">{labels.custom}</option></select></label>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">{numericFields.map(({ count, window, key, unit }) => <div key={key} className="rounded-xl border border-border bg-background/50 p-3"><p className="mb-2 text-sm font-bold">{labels[key]}</p><div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2"><label className="sr-only" htmlFor={`spam-${count}`}>{labels.threshold}</label><input id={`spam-${count}`} type="number" min={1} max={100} value={policy[count]} onChange={(event) => setField(count, Number(event.target.value) as GuildSpamPolicy[typeof count])} className="h-10 min-w-0 rounded-lg border border-border bg-background px-2 text-sm" /><span className="text-xs text-muted-foreground">{unit} /</span><label className="sr-only" htmlFor={`spam-${window}`}>{labels.window}</label><input id={`spam-${window}`} type="number" min={1} max={300} value={policy[window]} onChange={(event) => setField(window, Number(event.target.value) as GuildSpamPolicy[typeof window])} className="h-10 min-w-0 rounded-lg border border-border bg-background px-2 text-sm" /><span className="text-xs text-muted-foreground">sec</span></div></div>)}</div>
        <label className="mt-4 block text-sm font-semibold">{labels.action}<select value={policy.action} onChange={(event) => setField("action", event.target.value as SpamAction)} className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="LOG_ONLY">{labels.log}</option><option value="ALERT">{labels.alert}</option><option value="INCIDENT">{labels.incident}</option></select></label>
        <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-3 text-sm"><input type="checkbox" checked={policy.ignoreBots} onChange={(event) => setField("ignoreBots", event.target.checked)} />{labels.ignoreBots}</label><label className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-3 text-sm"><input type="checkbox" checked={policy.ignoreAdmins} onChange={(event) => setField("ignoreAdmins", event.target.checked)} />{labels.ignoreAdmins}</label></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">{labels.roles}<textarea rows={2} value={roleIdsText} onChange={(event) => { setRoleIdsText(event.target.value); setField("ignoredRoleIds", event.target.value.split(/[\s,]+/).filter(Boolean)); }} placeholder="123456789012345678, …" className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" /></label><label className="text-sm font-semibold">{labels.channels}<textarea rows={2} value={channelIdsText} onChange={(event) => { setChannelIdsText(event.target.value); setField("ignoredChannelIds", event.target.value.split(/[\s,]+/).filter(Boolean)); }} placeholder="123456789012345678, …" className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" /></label></div>
        <div className="mt-4 grid gap-3 rounded-xl border border-border bg-background/40 p-3 text-xs sm:grid-cols-2"><p><span className="font-bold">{labels.current}:</span> {isCustom ? describe(savedPolicy) : en ? "Legacy default · environment may override code defaults (3 messages / 5 sec)" : "従来の既定 · Bot環境変数で上書きされる場合があります（コード既定 3件 / 5秒）"}</p><p><span className="font-bold">{labels.next}:</span> {describe(draft)}</p></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p role="status" className={`text-sm ${status.includes("ません") || status.includes("Unable") || status.includes("Could not") ? "text-destructive" : "text-emerald-500"}`}>{status}</p><button type="button" disabled={saving || loadingPolicy} onClick={() => void reset()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50"><RotateCcw className="h-4 w-4" />{labels.reset}</button></div>
        {isDirty && <div className="mt-3 flex justify-end"><button type="button" disabled={saving || loadingPolicy} onClick={() => void save()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-50">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{labels.save}</button></div>}
      </>}
    </>}
  </section>;
}
