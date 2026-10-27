# Application-wide Multi-DB availability

## 判定と依存

本変更は #43 → #46（77753cf）からの積み上げDraft。main 25c7e80を含む。#44の自動ニュース配信先は含めない。
**全機能のNeon単独依存解消はまだ完了ではない。** 下記の実装済み経路と、未移管の内部機能を分ける。本PRをProductionへ有効化しない。
外部専用Supabase未用意に加え、未移管の内部コードもリリース条件。CI成功だけを全体完成と扱わない。

全sourceのSQL/接続/ローカルDB呼出候補は `application-database-inventory.md`。
`node scripts/audit-database-access.mjs` で再生成、`--check` で未分類経路をCI検出。動的SQLは静的一覧と手作業の呼出元確認を併用する。
本番の値・Guild数・同意は取得/推測しない。隔離試験のIDはすべて合成。

## データ所有権と接続

| データ | 権威・書込 | 読取/障害時 | 本変更 |
|---|---|---|---|
| Security同意/緊急停止/運営権限/ログ先 | #43/#46の2/3 Quorum、Epoch/CAS | 新鮮なQuorum、未確認は処罰拒否 | 維持 |
| メッセージ/反応/Voice/Memberイベント | SQLite WAL + Local-First Outbox | ローカル耐久保存、Cloud配送は独立 | 維持。全Guild Local-Firstを起動条件化 |
| Analytics Projection | 永続SQLite集計 → 承認済Publisher → 2/3 MDS + Quorum manifest | Webは同じmanifestで復元。NeonへのSQL fallbackなし | 実装 |
| Goals | 利用者/Guild別の暗号化MDS + Quorum manifest | Epoch/Revision CAS。未確認は明示確認して再設定 | API/UI実装 |
| 通知イベント | Botの新規観測 → Guild別alerts | Webは認可Guildだけを投影。履歴coverageを区別 | Bot/API実装 |
| 通知dismiss | 利用者/Guild別の暗号化MDS + CAS | 再起動後も保持。Auth FKやGET時INSERT不要 | API/UI実装 |
| チャンネル表示Metadata | Botの実Discord観測 → MDS/Quorum | 欠損は不明、旧cacheを新Epochへ昇格しない | Bot/Web実装 |
| API Rate Limit | 同一クラウドQuorumのbucket CAS | Quorum不足は拒否、プロセスメモリへの迂回なし | 実装 |
| Runtime/Lease/heartbeat APIと管理画面 | Quorum owner + MDSの実Bot/Worker観測 | owner/heartbeatが一致しない、古い観測、Quorum不足はUnknown/Critical | 移管済み。過去Host履歴・未観測Version/起動時刻・TTL満了時刻を捏造しない |
| 問い合わせ | 暗号化MDS + 送信前CLAIM | SENT/FAILED/UNKNOWN、UNKNOWN自動再送なし | API実装。外部メール自体のHAは保証しない |
| News/Evidence/Incident | 既存Quorum/MDS/Local Audit/Claim | UNKNOWNを無条件再送しない | #43/#46を保持 |
| Web Theme/Timezone/プロフィール | 既存の専用Auth storage | Supabase Auth構成ならNeonと独立 | 無断移管なし |
| OAuth/Session/Provider Token/Guild認可Cache | 専用Auth PostgreSQL | 専用サービスのHA/backup/PITRで保護 | コピー/昇格しない |

SQLiteは投票者ではない。Bot/Webの新しい設定はSQLiteだけを権威にしない。
通常のSQLを別製品へそのまま投げるProxyは作らない。Neon legacy schemaと新EpochのQuorum状態を混ぜない。

## 保証条件

- 既存3投票者のうち2正常なら継続。Neonをquarantineした初期状態はSupabase/Turso両方が必要。
- 2投票者未満では読取の確定も書込も拒否。2断片未満でも本文を復元しない。
- Byzantine耐性や独立性のない同一クラウド障害、無停止移管は保証しない。
- 旧Writerを外部で封鎖した新Epochだけを使用。Ping/時刻で権威を移さない。
- データごとにGuild/domain/owner/Epochを結合。個人別Goals/通知状態/問い合わせはAES-GCM保護、平文をクラウドへ直接保存しない。
- データmanifestをCASで確定して初めて保存成功。再試行のintentへ毎回変わる時刻/乱数を混ぜない。
- Analytics Publisherは独立の承認済ID/sourceEpochと単調なSQLite snapshotVersion watermarkを検証。低いsequence・異なるlineage・旧Publisherは拒否。
- データ再構築範囲や生成時刻を返す。変化のない古い集計を「今同期したから最新」に昇格しない。
- 新データのArtifact IDをQuorum修復catalogに**先に**登録。失敗時は未commitのcatalog項目が残るだけで、未登録の確定データを作らない。
- Workerはcatalogを巡回しMDSを修復。2断片がない/内容が矛盾する場合は安全停止し、LWW/自動マージ/削除しない。
- 長期稼働のmanifestは暗号化checkpoint archiveで論理圧縮。古いpromise/accepted valueは削除せず旧Writerを復活させない。

## 未移管の内部経路（対象外扱いではなく完成ブロッカー）

| 経路 | 現状/危険 | 必要な実装・代替 |
|---|---|---|
| History Import | PostgreSQL job lock/cursor/worker claimに依存。新モードでは明示503 | Quorum command/claim + generation fence、SQLite cursorとの二重実行防止、全状態遷移と中断/再開試験 |
| Message search | raw message全文Indexは未移管。新モードは明示503 | 既存保持/削除契約を維持した暗号化Index再構築、削除tombstone、全版の保持/GC、認可範囲試験 |
| Guild reset/データ削除 | 旧SQLだけの削除ではMDS/replicaが残る。新モードは実行拒否 | 全DB tombstone/世代barrier + 承認済backup + 各provider削除receipt + fail-resume protocol |
| Developer Guild blocklist | 旧テーブル/ローカルLKG参照が残る。新モードのWeb書込は禁止 | Guild別Quorum policy、未確認とallow/deny分離、Botの同期cache判定を実行前fresh gateへ置換 |
| Bot reaction roles | legacy SQL設定とlocal LKGが残る | 安全な再確認・Quorum設定・イベントごとのfresh権限確認。旧cacheを最新扱いしない |
| Translation usage | 外部有料Providerの月次quota予約/返却がNeon | 確認済残量からのQuorum予約・UNKNOWN請求区別。残量不明で外部有料呼出を許可しない |

上記のため**「全体Multi-DB完成」「Production ready」とは判定しない**。未移管SQLを新しいDBへ無条件に振り替える解消方法は採らない。

## Auth/外部サービスの残依存

Auth情報をMDSやTursoへ無断複製しない。Supabase Auth専用DBは接続プール/backup/PITR/サービスのHAにより保護し、書込権威は単一のままにする。
Auth DB自体の障害では新規ログイン/Session検証を安全停止する。古いSessionやGuild権限をoffline許可へ昇格しない。
真のAuthリージョン移管にはProvider Token、Session失効、UNIQUE identity、署名鍵、RPO/RTOとwriter fencingの専用設計・承認が必要。
Discord REST/Gateway、メールProvider、翻訳Provider等の停止はMulti-DBだけでは解消しない。UNKNOWN副作用を再実行しない。

## 本番に必要な条件（今回は実行しない）

1. Authと分離した専用Supabase、Turso、旧Writer封鎖、復元可能なSQLite/secret backup。#46の新Epoch手順を使用。
2. 上記内部ブロッカーを解消した統合版。Bot/Web/Workerを同じ新Epochへ揃え、旧Deploy/SQL資格情報/Discord Writerを封鎖。
3. `APPLICATION_DATA_MODE=quorum`、同じEpoch/control ID/prefixと暗号化key/key IDを全serverで共有。keyはSecret Storeに保存しブラウザへ渡さない。keyを失うと個人別データを復元できない。既存暗号文のkey rotationは別の移行が必要。
4. `APPLICATION_PUBLISHER_ID` / `APPLICATION_SOURCE_EPOCH`（新規32桁hex、Snapshot復元と混同しない）。`scripts/initialize-application-ha.mjs --plan=<reviewed.json>` は接続なしのplan-only。
5. `--execute-approved` は `APPLICATION_INITIALIZATION_APPROVED=<plan checksum>` と#46復旧manifest一致が必須。Publisher変更は無条件overwriteしない。実行しない限りDDL/初期化は起きない。
6. 未確認Goalsは管理者が新値として再設定。通知は移管後の新規イベントだけと明示。古い履歴をゼロ/全期間として偽装しない。
7. Hosted Supabase/Tursoで永続性・分断・再同期・backup restoreと代表APIを実測後に別途リリース判定。

## 検証境界

SQLite実装、隔離PostgreSQL、実Turso SDK localhost Hranaを使用。これはHosted Tursoの可用性証明とは異なる。
CIは実PostgreSQL再起動、暗号化Goals/manifest復元、dump/restoreの断片checksum照合を含む。
Mockでは認可、CSRF、API応答、期限、外部送信UNKNOWNを検証。実OAuth/本番DB/実Guild/本番メールは呼び出さない。
本番のMigration/Deploy/再起動/同意・Guild設定変更はNONE。

2026-10-27 local validation: Full 897 PASS / 16 SKIP / 0 FAIL、application focused 27 PASS、実PostgreSQL/Turso 2 PASS＋実DB再起動1 PASS。
Build / TypeScript / Migration integrity / diff-check / 変更ファイルSecret scanはPASS。Lint 0 errors / 既存8 warnings。
Production依存監査: Critical 0 / High 5 / Moderate 2 / Low 1（patched mainから依存変更なし）。開発依存の既知proxy-addr Criticalは別Security課題として残る。
GitHub CIの結果はPRのchecksを参照。実Browser/Discord/Hosted DB試験は未実施。
