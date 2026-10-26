# Hybrid Multi-DB統合レビュー（2026-10-25）

**隔離実装・試験用Draft。本番の移管・起動・設定変更・配信は未実施。**

## 統合基準

main `7088dd4`、#38 `42ac4e6`、#39 `754add1`、#40 `1458225`、#41 `b8cce05`。
#40から専用ブランチを作り、#41（#38を含む）を履歴を保持してMergeした。
競合した運営Roleの鮮度確認、Timeoutログ引数、Outbox保持条件、隔離DB試験を両方保持した。
Security Hotfixは独立PRの `c2866eb`。統合側にも取り込んで検証するが、Hotfix PRは依存2ファイルのみ。
本書は旧 `multi-db-coordinator-review.md` の未統合状態を更新する。

## データごとの権威

| データ | 確定権威 | SQLiteの役割 | 1DB障害 |
|---|---|---|---|
| 検知設定・強度・明示同意・Emergency・運営Role・ログ先 | 固定Neon/Supabase/Turso、2/3 Paxos | Audit/Outbox投影・検知cache。古いcacheは処罰同意に使わない | 初回移管済みなら残り2票で更新・整合読取 |
| ニュース配信先・Claim・結果 | 同じ固定3票、用途別namespace | 本文・DM session・配送状態・Audit・Outbox | WorkerのNeon状態だけでは止めず、実際の合意で判定 |
| Bot所有権（新しい明示opt-in） | 同じ固定3票 | ローカル起動保護は引き続き必要 | 残り2票でOwner確認。時間切れだけのOwner交代なし |
| Timeout Incidentの実行権 | Cloudの一意Claim + 既存SQLite耐久Claimの両方 | Incident、実行・ログ・Report段階を原子的に記録 | 不明なClaim・同意・権限・SQLite障害なら処罰しない |
| 大容量アーカイブ | 2/3合意Manifest + 任意2断片 | 作業用Journal | 2断片の保存・復元・修復が可能 |
| message/analytics | 既存Local-First/Projectionの鮮度契約 | WAL・Queue・Retry・DLQ | 既存の縮退動作。今回自動変換しない |
| OAuth/session/identity、Entitlement | 既存専用経路のまま | 認証の代替権威にしない | 他DBから勝手に再作成・統合しない |

## Control Planeの保証条件

- 固定3 acceptor、2票。membership/epoch/provider_idを照合。自動メンバー変更なし。
- 各slotは永続prepare/accept SQL CAS。最大accepted ballotを採用し、revisionと前checksumを照合。
- 整合readもpromiseの書込み・未決値の回復を伴う。SELECT専用DBはread quorum票にならない。
- Request ID再利用の内容不一致は拒否。結果不明を失敗・Rollbackと偽らない。
- 小さい設定は最大64KiB。資源namespaceを分け、Guild・用途が混ざらない。
- クラッシュ・遅延・分断が故障モデル。永続化済みvoteの巻き戻し、Byzantine改ざん、無断membership変更は保証外。
- 古いバックアップから戻したDBを無保護に再投票させてはいけない。下記quarantine手順が必須。
- 不確実なDiscord API結果をexactly-onceと呼ばない。UNKNOWNは再送・再処罰しない。

## BotとWeb

Web/Botは同じsecurity serviceとCAS tokenを使用する。既存Session/Guild認可/CSRF制約を保持。
DiscordはDB・権限fetch前にACK。運営Roleだけでは設定変更を許可しない。
Evidenceボタンも同じserviceでRoleを毎回再確認。Owner/Adminでも設定DBの可用性確認を省略しない。
Timeoutは24時間のまま。処罰直前に設定を読み直し、明示ON・Emergency OFF・検知設定一致とDiscord権限を要求。
同一Incidentはクラウドで1回だけClaimし、既存SQLiteのclaim/timeout_apiも必要。API応答とDB保存は原子化できないため、UNKNOWNを保持する。

ニュースはDM編集・プレビュー・最終確認・開発者ID Gateを保持。配信先未設定のfallbackなし。
Quorum modeではニュース配信先とClaim/結果も合意ログ。Workerは配送権を持たない。
旧ニュースmodeをQuorumへ切り替える際は、配信を止め、既存News ID/claim/outcomeを照合する。自動import・未配送の推測再送はしない。
本文/session/配送一覧は引き続きSQLiteなので、SQLite喪失時にはニュースの新規配信を停止する。クラウドからDM sessionを推測再作成しない。

## Erasure Coding

`xor-mds-3-2-v1` は2データsymbol + XOR parityのsystematic (3,2) MDS符号。
単なる3分割ではなく、(0,1)/(0,2)/(1,2)のどの正常2断片からも復元する。
消失訂正であり、暗号化やByzantine誤り訂正ではない。各断片SHA-256と全体SHA-256を検証する。

- 各artifact/versionはimmutable。異なるchecksumの同一キーへの書込みを拒否。
- 2Provider保存を確認してからManifestを合意確定。1断片しか保存できなければ確定しない。
- Manifestは専用Control namespaceに保持。新旧versionを混ぜて復元しない。
- 部分書込み・競合で残った未参照断片は自動削除しない。別途棚卸しが必要。
- 機密アーカイブはAES-256-GCMを必須にし、key自体はManifestへ保存しない。
- 復旧後は2正常断片から3断片を再生成。矛盾したchecksumは自動上書きしない。
- 現段階の適用先は明示的なアーカイブAPIとCheckpoint履歴。既存message/analytics/Incidentを自動変換しない。
- 1MiB fixtureの保存・復元: ローカル実SQLiteで14msの計測例。binary容量1.5倍、TEXT/base64保存では約2倍（2,097,156 bytes）。
  3重完全複製より少ないが、SQL/manifest/index overheadは別。Hosted価格・性能をこの数値から推定しない。
- 1artifact上限32MiB。Webの公開upload経路は追加していない。大きい履歴は運用上分割し、メモリとDB枠を監視する。

## Checkpoint / Compaction

`checkpoint-security-quorum.mjs` は既定PLAN_ONLY。実行にはepoch承認と非公開の32byte暗号鍵が必要。
履歴を暗号化EC archiveへ保存し、復元checksumを検証してから、別PaxosログでCheckpointを確定する。
通常readはCheckpoint以降だけを走査。再起動しても確定Checkpointを2票で読む。
古いCAS token/Requestの再利用は `MDB_CHECKPOINT_STALE` として拒否し、古い要求を再適用しない。
古い結果の監査確認にはarchiveを使用する。以前の結果を最新状態と偽って返さない。
**物理的なSQL履歴のDELETEは実装しない。** 永続promise/acceptedとAuditを残す非破壊のactive-log compaction。
ストレージの自動回収を完成したとは扱わない。ディスク容量・archive keyの独立backupと保持運用が必要。

## 初回移管（今回Productionでは未実施）

1. 全Bot/Web/CLI Writerと実行コード配置、Guild一覧、接続先を実測。Auth DBを除外。設定なしGuildも一覧に含める。
2. ソースDB・SQLite/WAL・クラウドの直前backupと、隔離DBへのrestoreを検証する。
   `verify-quorum-backup.mjs` はlocalhostの専用`*_restore_test`・空DB・checksum一致を必須とする。Production restoreは不可。
   pg_dumpはcustom形式、pg_restoreは同一/互換メジャーのClientを利用。CLIにSecretを引数で渡さない。
3. 全旧BotのDiscord処罰を停止・drainする。SQL triggerだけでは旧Botの処罰を止められない。
4. 既存ledgerのplan/checksumを確認し、別承認でschema/fenceを順序適用。今回は17件のManifest検証のみ。
5. 読取専用`plan-security-quorum-transfer.mjs`で対象Guildのsnapshotを私有ファイルへ取得。
   既存ON/OFF、強度、Role、ログ先、Emergencyを保持。欠損/不明は拒否。
   SQLite Authorityへ移管済みのGuildはNeon値を使わず、別途検証済みexportが必要として拒否する。
6. 人間がrestore証跡・旧Bot停止/drain・Writer一覧を照合し、計画checksumの承認artifactを作る。
   `transfer-security-quorum.mjs` はその承認・fresh backup checksumなしではexecuteしない。
   初期membershipは`--initialize-membership`を明示した場合だけ固定3者すべてを確認する。2者しか用意できない初回bootstrapは完了と呼ばない。
7. 旧表をlockし、計画とlive snapshotが一致するときだけ、SQL fenceと移管Journalを原子的にCommit。
   その後のCloud importは同じRequest IDで実行。途中停止後は同じ計画で再開し、fenceを自動解除しない。
8. Bot所有権も移す場合は計画へApplication IDを含める。全旧Bot停止後だけ空Ownerレコードを作る。
9. Bot/Web/Workerを同じepoch・Quorum modeへ揃え、全件照合後に段階再開する。設定・同意を無断変更しない。

**Neon停止中に旧設定のauthoritative snapshot・旧Writer封鎖を証明できなければ初回移管はBLOCKED。**
Supabase/Tursoにデータが存在するだけでは初期値に採用しない。移管完了後の2票可用性と混同しない。

## 新しいRuntime所有権

`NUVILOVIEW_SINGLETON_AUTHORITY=quorum` は別途承認後のopt-in。既存Neon Leaseのdefaultは変更しない。
固定3票の所有権を取得してからDiscordへ接続し、継続的に確認する。Neon不在でも2票なら継続。
第二Botの同時取得を拒否。Quorum喪失時は停止。通常はDiscord切断後に明示releaseする。
Ownerを時刻で失効させない。クラッシュ後・release結果不明は、旧Bot停止を実測した管理者による別承認handoffが必要。
`handoff-quorum-owner.mjs`は既定でplan/checksumだけを表示する。実行は直近のdrain証跡と計画checksum承認を要求し、CASで空Ownerへ移すだけでBotを起動しない。
この方式は安全側の運用であり、任意ホスト障害からの自動・無停止failoverを保証しない。
旧Neon Lease modeと新Quorum modeを同時に動かさない。Discord APIはfencing tokenを受理しないため、このdrain条件が必須。

## DB復旧・quarantine

- 通常の無損失再接続: read/recoveryで不足slotを修復。EC artifactはrepairで不足断片を再生成。
- 古いbackup/データ喪失からの復元: 投票させる前に全Writerへ`SECURITY_COORDINATOR_QUARANTINED_PROVIDERS`を適用し、旧DBアクセスを隔離。
- `rejoin-security-voter.mjs`は既定PLAN_ONLY。executeにはepoch承認が必要。残る元の2票から全namespaceの合意を回復して対象へ移す。
- 矛盾したaccepted値・余分なtail/resourceは保持して停止。自動merge/DELETEしない。
- 成功してもquarantineを自動解除しない。証跡確認後、全Writerの設定変更を別承認する。
- 告知なしのdisk rollbackを自動検出できるとは保証しない。永続voteを失ったProviderの無保護な再参加は禁止。
- 2票を失った場合は更新・処罰・新規配信を停止。どちらの古いbackupが正しいか推測しない。
- SQLite破損時はBot副作用を止め、原本を保全。修復/restore後、quorum journalを再投影。UNKNOWN配送は再送しない。
- RollbackでもCloud log/fence/claim/archiveを保持。SQLite-onlyや旧無保護Botへ戻さない。

## 新しい設定名（値は取得していない）

- `SECURITY_COORDINATOR_MODE=quorum`、`SECURITY_COORDINATOR_EPOCH`、専用`SECURITY_COORDINATOR_SUPABASE_URL`。
- `SECURITY_COORDINATOR_QUARANTINED_PROVIDERS`（任意、comma-separated voter IDs）。
- `NUVILOVIEW_SINGLETON_AUTHORITY=quorum`（別承認の移行後のみ）。
- `SECURITY_ARCHIVE_KEY` / `SECURITY_ARCHIVE_KEY_ID`（maintenance専用Secret、runtimeへ無条件配布しない）。
- `SECURITY_QUORUM_TRANSFER_APPROVED` / `SECURITY_QUORUM_MAINTENANCE_APPROVED`（計画/epochの明示承認）。
- `NEWS_BROADCAST_ENABLED` はdefault falseのまま。Guild送信先・Bot権限・Developer Gateを別途確認。

## 試験と残るGate

ローカル全体: 844 PASS / 12 SKIP / 0 FAIL。共通fixtureをhelperへ分離し、同じテストの重複登録を除いた件数。
隔離PostgreSQL/Auth/実Turso SDK: 46 PASS、実DB再起動後の確認: 1 PASS。
Build / TypeScript / Syntax（266 modules）/ Migration（17 + Auth 1）/ Schema drift / Token Scan / diff check PASS。
Lint 0 errors / 既存8 warnings。依存Critical 0（High 6 / Moderate 2 / Low 1は残る）。
Backup DryRunは空のgitignored一時`.env.local`のみ使用し、終了後削除。本番Secretを使っていない。

実SQLiteの固定票、実PostgreSQL隔離DB、実Turso HTTP SDKを使用。
Tursoの接続先はローカルHrana/SQLite transport。Hosted Tursoのleader切替/耐久性を証明したものではない。
100 Guild・16,000更新・400 Checkpointの故障注入負荷試験は107,143msでPASS。24時間soakではない。
1MiBのEC、任意2断片、破損、混在version、AES-GCM、欠損修復、CAS競合を検証。
実PostgreSQL再起動後の2票readを検証。CIにはcustom pg_dump/隔離restoreと合意履歴hash照合を含める。

本番相当/本番運用で未確認: Hosted分断・Turso強整合leader経路、モバイル回線、長期間容量/遅延、実Discord DM/Modal/ボタン、
本番の初回snapshot/backup/restore/旧Writer drain、Owner移管、全17 Guildの現在値。
Production readinessはこれらの承認・検証後に別判定。未検証をPASSとしない。
