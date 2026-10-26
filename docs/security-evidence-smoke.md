# Phase C — 利用者による実Discord検証手順（Production禁止）

2026-10-22 再監査版。実Discord操作は利用者が行います。この手順の実装・Mock検証は
実機検証PASSの代わりにはなりません。現時点で実機表示・TXTダウンロードは未検証です。

## 1. 何を検証するか

同じ `timeoutLogPayload`、`sendTimeoutIncidentLog`、Incident/Audit/Outbox、
`authorizeSecurityOperator`、Component Handler、TXT生成、専用REST送信を使います。
合成Incidentは**専用SQLiteだけ**に保存し、実ユーザーへのTimeout APIは一度も呼びません。
公開EmbedとTXTは「隔離テスト／合成記録／Timeout未実行」と明示します。

本番 `discord-bot.mjs` にはテストコマンド・テスト起動経路を追加していません。
Slash Commandの登録、Production接続、Worker起動、PostgreSQL接続もありません。
`/adsetroll`のSQL読み取りはこのランナーに限り、専用設定の固定ロール一覧に置き換えます。
**最新Member/RoleのDiscord取得と実際の認可関数は本体と共通**です。
PostgreSQLの実Operator設定・Audit整合性は別の隔離DBテストで検証します。

## 2. 専用テスト環境を作る（利用者操作）

- Productionとは別のDiscord Application/Bot、テストGuild、テスト用ログChannelを用意。
  既知Production Application ID `1523938138194444408` はランナーが拒否します。
  この非Secret IDは2026-10-22のProduction公開招待リンクで確認したものです。
  Production Botが将来変更された場合はdeny-listのレビューも必要です。
- BotはこのテストGuildにだけ招待。Gateway intentはGuildsのみ。
  Message Content・Guild Membersの特権Intent、Moderate Members、Administratorは不要。
- ログChannelでBotに View Channel / Send Messages / Embed Links /
  Attach Files / Read Message History を許可。BotにTimeout権限は付与しない。
- 報告受信Channelもテスト専用の非公開Channelとする。
  @everyoneのView Channelを明示DENY。
  開発者ロールだけにVIEWを許可。Bot自身にはVIEW/SEND/ATTACHを許可。
  Bot専用のmanaged role、またはBotメンバーへの上書きは利用可能。
  未承認のAdministratorロールは、Channel上書きがなくても送信拒否されます。
- Discord Guild Ownerは権限上書きでも閲覧を禁止できません。
  **受信Guild Ownerと許可Roleの全保持者が開発者かどうかは利用者が確認**してください。
  Role IDだけから本人が開発者かどうかをBotが推測することはありません。
  無関係な管理者がいる共用Guildは避け、専用受信Guildを推奨します。

設定変更をランナーが代行することはありません。誤設定時は公開先に転送せず拒否します。

## 3. ローカル専用設定（Tokenを会話に貼らない）

新しい端末で、Production用環境変数を読み込まずに実施します。
privateな場所の `.env.security-smoke.local` をエディタで作成してください。
ファイルには自分だけがアクセスできる権限/ACLを設定し、Gitへ追加しないでください。
以下は**値のないテンプレート**です。IDとテストBot Tokenは自分の環境で記入します。

```dotenv
NODE_ENV=development
SECURITY_SMOKE_SESSION=phase-c-01
SECURITY_SMOKE_APPLICATION_ID=
SECURITY_SMOKE_GUILD_ID=
SECURITY_SMOKE_LOG_CHANNEL_ID=
SECURITY_SMOKE_OPERATOR_ROLE_IDS=
SECURITY_SMOKE_BOT_TOKEN=
SECURITY_REPORT_GUILD_ID=
SECURITY_REPORT_CHANNEL_ID=
SECURITY_REPORT_RECEIVER_ROLE_IDS=
```

Operator roleはテストGuild内の運営資格用、receiver roleは開発者受信先の閲覧用で別物です。
Role IDはそれぞれカンマ区切り。Owner/Adminのみでの検証ならOperator roleは空で構いません。
受信先未設定の拒否を確認する最初のsessionではSECURITY_REPORT_*を3つとも空にします。
受信先を設定する検証は**新しいsession名**を使ってください。

本番の `.env.local` をコピー・読み込みしないでください。
`NUVILOVIEW_BOT_TOKEN`、`DATABASE_URL`等が継承された場合は拒否されます。
Tokenをコマンド引数、echo、画面共有、ログ、PRへ書かないでください。

## 4. Plan → 起動 → 1件だけ合成ログ

RepositoryのPR #38ブランチを配置し、Node24 / lockfileのpnpmで依存をインストール。
以下のprivateファイルパスだけを実際の保存先へ置換します。
これはVercel DeployでもProduction Bot起動でもありません。

```powershell
node --env-file="C:\private\.env.security-smoke.local" scripts/security-evidence-smoke.mjs --plan
node --env-file="C:\private\.env.security-smoke.local" scripts/security-evidence-smoke.mjs --connect-test-bot --post-synthetic
```

Planはネットワーク接続・ファイル作成とも0。実行には明示的なconnectフラグと専用Tokenが必要。
実行時はまずREAD-ONLYのBot identity確認を行い、想定Applicationと違えばGateway接続・投稿前に停止。
初回接続後、ログ先/受信先の権限を検証してから合成データを保存・投稿します。
同じsessionへの`--post-synthetic`再実行でも、永続claimにより同じログを再投稿しません。
送信結果不明でも自動再送はしません。新sessionでの再投稿も、既存履歴を照合してから判断してください。

専用データは `output/security-evidence-smoke/<session>/` のみ。
SQLite、WAL、session marker、単一起動lockを使います。
symlink/junction、hard-link、markerのない既存DB、session設定変更は拒否します。
本番DBファイルやそのコピーを置かないでください。

## 5. 実操作チェックリスト

実測した項目だけPASSとしてください。実ユーザーのTimeoutや実Spam投稿は不要です。

| 操作 | 期待結果 |
| --- | --- |
| 合成ログ表示 | 隔離テストの明示、動的Timestamp、1日の合成結果、ユーザー情報、Case ID、横並び2ボタン |
| 投稿直後→編集後 | 通知先成功文はDiscord送信成功・Message ID保存後の編集で追加 |
| Owner/Admin/運営Roleで検知データ | 受付後に非公開TXT。Discordでダウンロードし、UTF-8の日本語・日時・ID・件数8・窓10秒を確認 |
| TXT内容 | 合成記録/Timeout未実行、記録時点の結果、強度UNKNOWN、秘密/生発言なし |
| 一般メンバー / Manage Guildだけ | 検知データ・報告とも拒否。外部送信0 |
| 運営Roleを外した後 | 以前押せた同じボタンも拒否 |
| Roleを削除した後 | stale cacheから許可しない |
| 未設定の受信先 | 「開発者への送信先が設定されていないよ。」、成功表示なし |
| 設定済みの受信先で報告 | private Channelに合成記録のUTF-8 TXTが1件、Report IDと成功結果 |
| 同時クリック / 再クリック | 同一Incidentの追加送信0、既存状態とReport IDを表示 |
| 受信先権限を削除 / publicに変更 | **新しいIncidentの検証で**送信拒否、別Channelへのfallbackなし |
| ログを編集 / 削除 | 古い表示や別メッセージからの参照は拒否 |
| Bot再起動後 | 元のボタンからTXTを参照可能。報告済みなら再送0 |

再起動は**このテストランナーだけ**をCtrl+Cで終了して、同じsession設定で次を実行。

```powershell
node --env-file="C:\private\.env.security-smoke.local" scripts/security-evidence-smoke.mjs --connect-test-bot
```

`--post-synthetic`は不要です。再起動時に新しいIncidentを勝手に作ることはありません。

## 6. 状態確認 / 異常時

```powershell
node --env-file="C:\private\.env.security-smoke.local" scripts/security-evidence-smoke.mjs --inspect
```

これは専用ローカルDBだけを開き、Report ID/状態を表示します。Token出力なし。
CLAIMED/UNKNOWNは送信済みの可能性があるため、自動再送・claim削除は禁止。
実際のprivate ChannelのMessage IDとローカルAuditを照合して判断します。
送信4xxはFAILED、ネットワーク/5xxや送信後の保存失敗はUNKNOWN相当です。

異常終了でrun.lockが残った場合、自動削除・二重起動は行いません。
**自分のテストランナーのプロセス終了を確認した後だけ**、該当sessionのrun.lockをエディタ等で削除。
本番BotのPID/lock/環境ファイルに触れないでください。

検証後はテストランナーを停止。送信したテストログ/TXTはDiscord上で利用者が片付けます。
SQLiteは履歴/重複確認のため保持可能。削除する場合もテストsessionフォルダだけを明示して扱い、
未知の送信を再実行するためにclaimを消さないでください。ローカルDB削除だけではDiscord添付は消えません。

## 7. 本番前ゲート（別途承認）

チェック表の実測、開発者受付の3設定・Owner/Role保持者確認、保持/削除ポリシーをレビュー。
その後に初めてProductionのMerge/設定/Deploy/Bot更新の承認を求めます。
この手順を完成したことをもって、実機PASSやProduction Release Completeとは報告しません。

参考: [Discord permissions](https://docs.discord.com/developers/topics/permissions)、
[Interaction ACK](https://docs.discord.com/developers/interactions/receiving-and-responding)。
