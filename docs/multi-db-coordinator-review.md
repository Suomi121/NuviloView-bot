# Multi-DB Coordinator: 実装・保証境界・移管レビュー

統合更新: [Hybrid Multi-DB統合レビュー](hybrid-multi-db-release.md)を参照。
以下はPR #40単体時点の記録であり、#38/#41統合後の完成範囲を示さない。

2026-10-25。**Draft / Production未適用。本番導入GOではありません。**

## 監査基準・依存関係

- origin/main: `7088dd41658b85094eae7bfacc9bf6e76cf8d8cb`。
- PR #39: `754add135f61007b6554150a5ee83c14ae7fdf73`、main起点のDraft。
- PR #38: `42ac4e631fa13ab032595183519be0aa6e6c11ed`、同じmain起点の独立Draft。
- 本ブランチは#39の上に積む。#38は含めない。Productionの現在値は今回取得していない。
- #39のSQLite権威は最終設計にしない。互換用コードは残るが、quorumと同時有効化は起動時エラー。

## 旧構成の問題とデータ所有権

| データ | 旧権威・経路 | 障害・古い値の危険 | 今回の扱い |
|---|---|---|---|
| Spam検知設定 | Bot SQL/ Web pool → Neon | Neon停止で保存不能。別DBの単純な昇格は二重Writer | 移管済みGuildは共通quorum logでCAS |
| #39移管後の検知設定 | 指定ホストのSQLite → Outbox → replica_event | SQLite喪失で権威停止、Web409、処罰恒久OFF | quorumからは採用せず、再移管には新たな承認と照合 |
| v2 enrollment / Auto同意 / Emergency | Neonの専用表・監査 | 古いONや欠損からの推定は危険 | Guild aggregate内で別フィールド。保存済み値を検証して移す |
| 運営ロール / ログ先 | Neonの独立表 | 古いRoleキャッシュ、他Guild参照、失敗時の誤転送 | 同じaggregate。Discordの最新資格・Channel権限は別途再検証 |
| Incident / Timeout実行・ログ送信 | SQLite security_audit + 原子的Outbox | 応答不明後の外部API再試行は二重処罰 | 既存at-most-once claimを維持。SQLite不使用で処罰しない |
| message / analytics | Local-First SQLite、Worker、cloud projection | cloudは非同期、履歴欠損を最新と扱えない | 既存Read Router・鮮度・Retry/Circuit/DLQを保持 |
| Auth user/account/session/UNIQUE | 専用Supabase Auth DB / auth-storage | 同一identityの他DB自動登録は所有権を破壊 | 移管しない。Auth障害時は既存拒否、複製から認証しない |
| Entitlement / developer判定 | 既存server-side経路 | 設定DBの権威と混ぜると権限昇格 | 変更しない |
| 分散Singleton | 既存Neon lease (有効時) + Android singleton | Lease未証明で別Botを起動すると二重実行 | 変更しない。Neon依存が残る明示的な本番ブロッカー |

## 固定クラウド多数決

`Neon / 専用Supabase / Turso` の**固定3 acceptor・2票**。SQLiteは票ではなくローカル耐久投影。
`mdb_membership`にはepoch・固定構成とProvider IDを保管し、各操作で照合する。同じDBを2つのProviderとして設定してもID照合により2票にならない。

Guildごとに連続slotのPaxos logを使う。各slotはprepare → accepted値の採用 → acceptの多数決。
prepareはDB内の単一UPSERT CAS、acceptはpromise一致の単一UPDATE CAS。約束は返答前に永続化される。
ballotは64bitカウンタとランダム128bit proposer IDの組。再起動時にはDBのpromiseを観測して上げる。時計は順序判定に使わない。
accepted済み値を発見した場合は最大ballotの値を必ず採用し、自己都合の値で置換しない。
新しい更新はrevisionと直前checksumの双方が一致しない限り拒否する。
各値にGuild、epoch、revision、前checksum、actor、request ID、操作、内容hashが入る。履歴はhash chain。
同一request ID・同一内容は元の結果を返し、異なる内容の再使用は拒否する。

readもprepareで最初の空slotを封鎖し、未決accepted値を回復してから返す。
従ってreadはSQL SELECTだけではなく**promiseを書き込む整合読み取り**である。
DBがSELECT可能でもprepareを書けなければ多数決のread権威とは扱わない。
`inspect`だけはSELECTのみで、観測したaccepted数を返すが、それを「確定revision」とは呼ばない。

安全根拠はprepare多数集合と過去accept多数集合の交差、および交差点での永続promise/accepted保持。
この構成に常設primaryはない。正当性は「どのDBに切替えたか」でなく、slotの2票で決まる。
古いproposerは新promise後に過半数acceptできない。旧SQL経路は別のNeon trigger fenceで止める。

### 保証の前提と非保証

- crash/recovery・通信断・遅延・応答消失を対象とし、DB/アプリのByzantine改ざんは対象外。
- 各acceptorのSQL CASと成功応答済みデータの永続性が必要。Tursoは書込みleaderの強整合経路であることが本番前提。
- acceptorの古いバックアップを投票資格付きで戻す行為は禁止。データ喪失したvoterは隔離し、多数派から検証復旧する。
- 固定メンバーの無断入替、epochだけ書き換えた昇格、membership削除、少数派bootstrapは禁止。
- 無期限ネットワーク分断でも書き込める、待ち時間ゼロ、全機能無停止、完全なexactly-once Discord処罰は保証しない。
- 結果不明のacceptは`MDB_OUTCOME_UNKNOWN`。巻き戻ったとは報告せず、同じrequest IDと元のCAS tokenで確認する。
- 競合proposerが連続すると一時拒否・livelockがあり得る。自動無限retryなし。
- 実装は安全側の全slot検証で、1000slot上限。長期運用用の検証済みcheckpoint/compactionと負荷試験が**未完成**。

## Bot / Web / Security

共通`security-service`で検知強度、Auto同意、Emergency、運営Role、ログ先を別フィールドで管理。
設定行がないGuildを旧SQLやキャッシュへ暗黙fallbackしない。移管未完了は拒否し、旧ONも復元しない。
明示importは保存済みON/OFFをそのまま要求し、勝手にOFFへ初期化しない。
新Guildの初期snapshotはOFFだが、実Guildのenrollment運用は別途承認された移管手順が必要。

- `/spamprotection level/status/auto`、`/adsetroll`、`/tosetlog`を同じserviceへ接続。
- InteractionはDiscord・DB読み取り前にACK。書込直前に資格を再取得。
- 運営Role単独に設定権限を与えない。Owner/AdministratorとManage Guildの既存境界は維持。
- Webは既存session/Guild認可/CSRF/body上限/rate limitを維持。PUT/PATCHはrevision/checksum/request IDを要求。
- 競合409は「再読込」、多数決失敗503は「保存結果未確定」の表示。UIのGuild switch/race guardは維持。
- Autoは明示ON、移管complete、Emergency OFF、最新設定一致、通常の対象/Bot権限とIncident耐久claimが必要。
- 直前に新たな整合読み取りを行う。OFF・欠損・少数派・障害・古い検知policyは処罰を許可しない。
- 正常な2票が残れば、明示同意のあるAutoは恒久OFFではない。既存24時間Timeoutを維持。
- Discord APIとDBは単一transactionにできない。最終確認とDiscord副作用間の競合を完全ゼロと保証しない。

## 再同期・監査

多数決log自身がクラウド上の耐久履歴。Bot/WorkerのSQLite journalはAudit+Outbox+Deliveryを原子的に投影する。
SQLite停止中のWeb更新も2票で確定し、後で全logを投影できる。
投影失敗はクラウドCommitのRollbackとは報告しない。SQLite障害時にIncidentなしで処罰を継続しない。
既存Workerに任意のreconciler hookを追加。quorum有効時だけ、最大1分ごとに1 Guildを巡回回復する。
稼働Guild数分の巡回時間と既存Worker backlogにより復旧時間は変わる。単なる時刻LWWはしない。
不一致は`MANUAL_CONFLICT_REVIEW`とし、履歴削除・自動merge・DLQ自動削除を行わない。
quorumイベントは既存Outboxの自動retention対象外。容量監視・アーカイブ設計は必須。

`node scripts/inspect-security-quorum.mjs --guild=<ID>`は接続後SELECTのみ、値・接続先・個人情報を表示しない。
`--repair`はpromise/acceptedを書き込むので、Productionでは別途承認が必要。
既存`inspect-sync-queue`、`monitor-runtime`と併せてprovider別配送・Retry・DLQ・最終成功時刻を確認する。

## 本番前の移管条件（今回は未実施）

1. 接続先・Bot実パス・旧Writer全件・Guild一覧を実測し、Auth DB分離を確認。専用Supabase voterを用意する。
2. SQLite/WALと各クラウドの直前backupを取得し、隔離DBへのrestoreと履歴のchecksumを検証する。
3. **旧Botの処罰を停止・Drainし、全旧Writerを封鎖する。** SQL triggerだけでは既起動BotのDiscord処罰を止められない。
4. 既存Migration runnerのplan/checksum/manual approvalに従い、Neonの新schema/fenceを適用する。
   Supabase/Tursoは`ACCEPTOR_SCHEMA`と同じ専用表を別承認で構築する。Auth DBへ構築しない。
5. runtime Roleはmembership/fence変更・DELETE/TRUNCATE・trigger無効化を禁止。membershipは別管理Roleが固定する。
6. 旧表をtransaction内でlockし、設定・同意・Emergency・Role・ログ先を照合してsnapshotを採取し、Guild fenceをCommit。
   完了済みv2と欠損判定を検査し、ON/OFFを変更しない。全Guild・設定なしGuildも対象。
7. 3者の固定membershipを照合後、`importFenced`へ検証済みsnapshotと実際のfence検査を渡す。
   現時点で**本番向けの多DB移管CLI/原子的計画保存/Crash再開の統合は未完成**。手動で真偽値を与えて代用しない。
8. Bot/Web/Workerを同じepoch・quorum modeへ揃える。legacy/SQLite authority mode混在は不可。
   `SECURITY_COORDINATOR_MODE=quorum`、`SECURITY_COORDINATOR_EPOCH`、専用`SECURITY_COORDINATOR_SUPABASE_URL`が新しい設定名。
   既存DATABASE_URL/TURSO設定を使用するが、この開発では取得・変更していない。
9. Singleton・Auth障害時運用の残課題、実Turso leader/read経路、長期log負荷試験を完了してから本番GOを再判定する。

rollbackではfenceと多数決logを保持する。無保護な旧Botへ戻さない。旧権威へ戻すには全Writer停止、最新合意snapshot照合、新しい移管承認が必要。
旧acceptorのデータ破損・checksum不一致・移管途中は拒否のまま維持し、推測復元しない。

## PR #38との関係

#38はIncidentボタン/TXTの独立Draft。今回その機能をDeploy/mergeしない。
`authorizeSecurityOperator`に共通serviceの任意引数を追加し、Roleの最新合意を使えるようにした。
#38統合時には全ボタンから同じserviceを渡す配線と回帰試験が必要。既存の2引数だけでは移管済みの委譲Roleを確認できず、安全側に拒否する。
Timeoutログ送信先の読み取りは今回serviceへ接続済み。ボタンをquorum対応済みとは主張しない。

## 試験の意味

実SQLite SQL、localhost PostgreSQL、ロック済みの実Turso HTTP SDKを用いる。
Turso SDKの接続先はテスト用Hrana/SQLite transportであり、**実Tursoクラウドの耐久性・leader切替試験ではない**。
実クラウド/モバイルネットワークでの故障注入、長期負荷、実Discord、Production移管は未実施。
Mockを本番可用性証明と置き換えない。

### 2026-10-25の実測

- ローカル全体: 719 PASS / 11 SKIP / 0 FAIL。Backup DryRunは空・0byte・gitignoredの一時`.env.local`のみ使用し、削除済み。
- 隔離PostgreSQL + 実Turso SDK/localhost transport + Auth実callback回帰: 46 PASS / 0 FAIL / 0 SKIP。
- Build / TypeScript / Syntax（222 modules）/ Migration checksum（16 + Auth 1）/ 静的Schema整合 / diff checkはPASS。
- Lint: 0 errors / 既存8 warnings。Discord Token ScanはPASS。汎用Secret heuristicの7件は未変更baseline内で、新規追加検出なし。
- dependency auditは**FAIL: Critical 2 / High 7 / Moderate 2 / Low 1**。依存ファイルはmain/#39と同一。
  `GHSA-2464-fhr4-w9xw`と`GHSA-673q-mjm6-r5xr`がNext 16.3.8に報告されている。
  監査を除外・弱化せず、別Security Hotfixで解消してからCIとリリースを再判定する。
- Vercelの既存認証済みCLIから正規APIで対象Project/TeamとGit未連携を確認。ブランチPushによる本番自動Deployなし。
  CLIによるDeployも行っていない。依存監査FAILのためCI全PASS・本番GOとは判定しない。

根拠: [Lamport, Paxos Made Simple](https://www.microsoft.com/en-us/research/publication/paxos-made-simple/)、
[PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html)、
[Turso transaction model](https://github.com/tursodatabase/turso/blob/main/docs/manual.md)。
