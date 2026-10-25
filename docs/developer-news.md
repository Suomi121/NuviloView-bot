# 開発者専用ニュース配信（Draft / 本番未反映）

## 基準と依存

main `7088dd4`、PR #38 `42ac4e6`を確認し、#38の上に独立ブランチを作成した。
これにより検知データ/TXTボタンの回帰も試験できる。#39 `754add1`、#40 `1458225`は並行Draftであり、このブランチには含めない。
`s?news`は既存`r?`セキュリティprefixと競合しない。Slash Command定義・登録は変更しない。

現行コードには`AI_OWNER_USER_ID`を使う開発者認証はない。
既存`isResetDeveloper`（名前にかかわらずIDだけを検証する共通Gate）を再利用し、
`DISCORD_OWNER_USER_ID` / `GUILD_RESET_DEVELOPER_IDS`の既存Developer IDだけを許可する。
表示名・Role・Administrator・Manage Guildから昇格させない。

## 利用手順

1. 開発者がBotとのDMで`s?news`。Guild内でも呼べるが、元のテキスト自体はGuildメンバーに見える。本文や結果は公開しない。
2. 作成画面は開発者DMへ送る。DM不可なら公開代替はせず、未結合Draftをcancelする。
3. 「内容を編集」でタイトル・本文・任意HTTPSリンク・`#RRGGBB`カラーを入力。
   title 256、body 4000、url 1024、field数0。mentionsは無害化し、allowedMentionsも空。
4. 「配信先設定」で実在Guild IDとChannel IDを指定。解除は`off`。開発者IDを再検証し、Botが現在参加し、ChannelがそのGuildに属し、
   View Channel / Send Messages / Embed Links / Read Message Historyがある場合だけ保存する。
   通常テキスト/Announcement Channelを許可し、threadや別Guildを拒否する。自動crosspostしない。
5. 「プレビュー」は最終配信と同じEmbedを非公開表示。
6. 「全Guildに送信」でページングしたDiscord APIの現在参加一覧（200件/ページ）を取得する。17を固定しない。
   対象・設定済みチャンネルrevision・本文を凍結し、内容と対象数を表示する。
7. 別の「この内容・対象に確定配信」を押すまで送信しない。確認前はcancel可能。
8. 結果はDM画面で更新。失敗・結果不明・対象外のGuild IDと安全な理由コードは開発者だけへ返す。
9. 操作期限は15分。期限切れや再起動後は`s?news status <News ID>`で新しいDMセッションを開く。
   旧nonce/version/message IDのボタンは使えなくなる。公開済み本文は変更不可。
10. 明確に拒否されたfailed Guildだけ「失敗Guildへの再送を確認」→別の最終確認で再送できる。
    429は最低60秒（返されたretry_afterがより長ければその時間）のcooldownを守る。
    未設定/退出済み/結果不明をこの操作で強制送信しない。配信先を変更した場合も別チャンネルへ自動転送しない。

## 永続化と監査

既存SQLite `sync_metadata` の`news:v1:*`、`news-destination:v1:*`、`news-index:v1`を使う。
設定・本文・session・delivery状態はSQLite transactionで、既存security Audit/Outboxと一緒に保存する。
本文の各状態にchecksum、確定後はpublicationHashを保持する。新DDL・Migrationは不要。
draft本文はローカルのprivate状態。配信確定した本文は`news_audit_v1` publicationイベントでクラウド複製される。
ニュースなので本文は公開予定データである。Secret・OAuth・他人の非公開情報を本文に入力しない。

送信先未設定はunconfiguredとして数え、検知チャンネル・system channel・一般チャンネルへのfallbackは一切ない。
設定・準備・確認・claim・配送結果・再送・復旧をAuditに記録する。
処理件数上限はニュース履歴1000件・1配信10000 Guild。上限超過では拒否し、証跡を勝手に削除しない。
長期アーカイブには重複防止tombstoneを残す別の運用レビューが必要。

## Discord副作用とMulti-DB

SQLiteのdurableな`sending` claimを先にCommitし、Discord API前に既存Provider Adapterの
`replica_event`へランダムclaim nonce付きの同一event IDをINSERT-if-absentする。
Neon / Supabase / Tursoのうち異なる2系統から、そのclaimのchecksum一致成功が必要。
他のnonceは同一IDと異なるchecksumなので競合し、交差する2票を同時に取れない。
少なくとも2系統を読めなければ新しいclaimを作らない。どこかに既存claimがあれば再送しない。
単なるpingや接続成功は送信権ではない。

この小さな合意は**単一の不変な配送claimの所有権**に限る。
#40のmutable設定Coordinatorを完成させた／全Multi-DBの強整合を保証したとは主張しない。
Providerの正しいUNIQUE/INSERT-if-absent・成功応答前の永続化・履歴非削除が前提。Byzantine DBや古いcloud backupの無保護な再投入は非対応。
可用性より重複防止を優先し、衝突や不明な結果では送らない。

Worker HEALTHY/RUNNING、90秒以内の新しいmetrics、SQLite integrity、必須ProviderのhealthとDLQをチェックする。
claim/resultは既存Outboxにも保存し、Workerはクラウドへの保存だけを行う。Discordへの送信をOutboxで再生しない。
claim/result/news Auditは通常のOutbox期限削除から除外する。Provider側の同イベントの削除も本番運用で禁止する。

## 故障時

- ローカルclaim・クラウドclaim・送信後保存の途中停止: sendingをunknownへ隔離。再起動とserial tickで回復するが自動再送しない。
- Discord success後にDB保存失敗: successと偽らずunknownにする。古いclaimを再利用しない。
- timeout/408/5xx/response不整合: unknown。履歴に見つからないことだけで未送信と断定しない。
- 403/404/429などの明確な拒否: failed。結果を2系統に保存・検証できなければ手動再送も拒否する。
- 再送前の履歴に自Botの同News IDがあれば止める。nonce/enforceNonceは補助であり、長期重複防止の根拠にしない。
- 送信前後にGuild脱退・channel削除・権限失効: 記録して停止。別チャンネルへ送らない。
- Multi-DB/Worker/SQLiteが不健全・metricsが古い: 新規配信確認・再送・新たな外部送信を停止する。
- SQLiteのrollback/restore、ホスト移管、replica_event破棄時: flagをOFFにして停止を維持し、ニュース履歴/claim/outcomeを照合してから別途承認。
  一般のmutable設定の復元や不明な状態の自動mergeをこの機能に持ち込まない。

## Interaction期限

通常ボタンとModal submitはdeferReplyをDB/ネットワーク待ち前に実行する。
フォームを開く際はshowModalが初期ACKになるため、Developer IDと短命の表示用session cacheで先に検証する。
このcacheはフォーム表示にしか使わない。submit・設定変更・確認・再送では永続sessionを再検証する。
ユーザーID、DM channel、元Message ID、nonce、revision、期限を結合し、他人/旧画面/Modal再送を拒否する。

## 本番設定（今回は設定していない）

- `NEWS_BROADCAST_ENABLED=true`（新規、default false）。既存Developer ID設定が必要。新しいTokenは不要。
- 既存Local-First SQLite・Multi-DB Sync・Workerと、必要なreplica_event schema/資格情報を確認する。
- BotにMessage ContentとDirect Messages intent。Direct Messagesは今回コードに追加済み。
- 配信先は全Guild未設定が初期値。開発者が明示設定するまで配信しない。既存Guildの設定は変更していない。
- DM可否とChannelの4権限を、専用テストBot/Guildで確認してからリリース承認を得る。
- Web/APIのDeploy・DB Migration・Slash再登録はこの機能に不要。
  Bot更新/必要なrestartは別途承認が必要。Workerが実際に参照する配置にも新しいOutbox保持条件があるか確認する。
  旧Workerが別配置の場合、保持条件の反映方法・更新/再起動の要否を別途レビューして承認を得る。今回はWorker/Supervisorを変更・再起動していない。

## PR #39/#40との統合注意

metadata namespaceは各PRと分離している。Outbox retention条件を併合するときは、news3種と
`spam_policy_authority_v1` / `security_quorum_v1`の保持条件をすべて残す。WorkerにDiscord再送を追加しない。
#40との統合・クラウド実機故障試験を、このブランチで完了したとは報告しない。

公式仕様: [Discord Embed/Message](https://docs.discord.com/developers/resources/message)、
[Interaction initial response](https://docs.discord.com/developers/interactions/receiving-and-responding)。

## 検証と未検証

- 専用ニュース試験: 30 PASS（実SQLite、Discord Mock、cloud claim Mock）。
- 全体: 775 PASS / 10 SKIP / 0 FAIL。空・0byte・gitignoredの一時`.env.local`以外のSecretは使わない。
- 隔離PostgreSQL回帰: 44 PASS。既存PG/Turso Provider Adapterによる競合claim、Neon読取専用時の2票、結果の冪等保存も含む。
- Build/TypeScript PASS。Lint 0 errors / 既存8 warnings。Syntax 222 modules PASS。Migration 14 + Auth 1のchecksum PASS。
  Token Scan PASS。依存ファイルは変更しない。
- 実DiscordでのDM/Modal/実配信、実17 Guildの配信先、実クラウドへのwrite、ProductionのRuntime状態は未検証。
- 既存Next16.3.8のCritical advisory 2件によりdependency audit/CIの依存監査は失敗し得る。安全チェックを弱めない。
- #39/#40との実統合とmulti-host/DB rollbackの本番運用試験は未実施。
  この機能は既存の単一Bot Runtimeと明示的な復旧手順が前提であり、無保護なDB巻き戻しを承認しない。
