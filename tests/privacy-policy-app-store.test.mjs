import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const privacyPath = new URL("../app/privacy/page.tsx", import.meta.url);
const docsPath = new URL("../app/docs/page.tsx", import.meta.url);
const auditPath = new URL("../docs/privacy-app-store-audit-20260903.md", import.meta.url);

test("Privacy Policy accurately discloses Local-First raw and Cloud Projection storage", async () => {
  const policy = await readFile(privacyPath, "utf8");

  assert.match(policy, /最終更新日：2026年9月3日/);
  assert.match(policy, /個別イベントをBotの稼働環境にあるSQLiteへ保存/);
  assert.match(policy, /本文を含まない集計スナップショットをSupabaseおよびTursoへ同期/);
  assert.match(policy, /完全に匿名化された情報ではありません/);
});

test("Privacy Policy does not deny individual reaction storage", async () => {
  const policy = await readFile(privacyPath, "utf8");

  assert.match(policy, /リアクションした利用者のDiscord ID/);
  assert.match(policy, /リアクションの追加・削除、絵文字/);
  assert.doesNotMatch(policy, /個々のリアクション内容やリアクションした利用者は保存せず/);
});

test("Privacy text does not promise an unimplemented universal 90-day local retention", async () => {
  const [policy, docs] = await Promise.all([
    readFile(privacyPath, "utf8"),
    readFile(docsPath, "utf8"),
  ]);

  assert.match(policy, /すべてに共通する90日以内の自動削除を保証する機能は本番運用されていません/);
  assert.match(docs, /ローカル保存データすべてに共通する90日以内の自動削除は保証していません/);
  assert.doesNotMatch(policy, /検索用に保存するメッセージ本文は原則として最大90日間保存/);
  assert.doesNotMatch(docs, /検索機能のため、メッセージ本文・送信者・送信日時を最大90日間保存/);
});

test("Privacy Policy names current processors and does not overstate account deletion", async () => {
  const policy = await readFile(privacyPath, "utf8");

  for (const provider of ["Discord", "Vercel", "Supabase", "Turso", "Neon", "Resend", "Google"]) {
    assert.match(policy, new RegExp(provider));
  }

  assert.match(policy, /現時点では、利用者がWeb画面だけでアカウントと関連データの完全削除を開始・完了できる機能はありません/);
  assert.match(policy, /アカウント削除は現在サポートへの申請が必要/);
});

test("Privacy Policy describes AdSense processing and user controls", async () => {
  const policy = await readFile(privacyPath, "utf8");

  assert.match(policy, /Google AdSenseの広告タグ/);
  assert.match(policy, /広告Cookieや端末・ブラウザを区別する識別子/);
  assert.match(policy, /https:\/\/policies\.google\.com\/technologies\/partner-sites/);
  assert.match(policy, /https:\/\/adssettings\.google\.com\//);
});

test("Internal audit separates current Production from unmerged Retention work", async () => {
  const audit = await readFile(auditPath, "utf8");

  assert.match(audit, /origin\/main.*3bd04b6d7cfa69a97cb413f9620aed94d2be3ea7/);
  assert.match(audit, /Excluded: open PR #22/);
  assert.match(audit, /## 3\. Internal data inventory/);
  assert.match(audit, /## 6\. Feature classification/);
  assert.match(audit, /## 8\. Privacy gap report/);
  assert.match(audit, /## 9\. Product gaps/);
  assert.match(audit, /## 10\. App Store Privacy mapping/);
});
