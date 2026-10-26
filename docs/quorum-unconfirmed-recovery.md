# Neon不在・旧Snapshotなしの新Epoch Recovery

## 目的と変更点

PR #43の2/3固定票を維持し、旧設定の完全復元を初回導入の必須条件から外す。
これは旧Neonへ初期値を上書きする処理ではない。旧データを残し、別の新Epochで「未確認」状態を記録する。
基準: #43 `12e5bd9` + patched main `25c7e80`。#44の自動ニュース配信先選択は含めない。

| 状態 | 意味・動作 |
|---|---|
| unset | 新Epochへの登録なし。GETで409、未設定と表示。デフォルト保存や自動処罰なし |
| unconfirmed | 外部Writer封鎖後に管理操作で作った未確認レコード。旧設定の復元値ではない |
| partial | 分野ごとに明示確認が進んだ状態。通常設定の保存で同意・緊急停止を確認済みにしない |
| complete | 全5分野が新Epochで明示的に確定。従来形式の検証済みimportも互換維持 |
| unavailable | 合意不能・DB障害。503、read-only。成功や未設定と偽らない |

通常設定のフォームは新しい案として表示。未確認時は全項目を見直すチェックなしでは保存しない。
APIもRecovery ID＋Revision/Checksum/CASを検証する。既存session/Guild/CSRF/制限・権限再確認は維持。
未確認の強度だけを変更して残りの旧設定を推測する操作は拒否し、まずWebで検知設定一式を明示保存する。
以後のlevel等は通常どおり更新できる。

## セキュリティ情報

`verification`はpolicy / autoTimeout / emergencyStop / operatorRoleIds / logChannelIdを永続的に区別する。
未確認レコードのeffective autoTimeout=false / emergencyStop=true / roles=[] / log=nullは実行ガードであり、旧値の断定ではない。
UI/Discordでは未確認と表示する。

- Auto同意未確認、緊急停止未確認、検知設定未確認のいずれかがあれば自動処罰しない。
- 検知設定保存はAutoをONにせず、同意を確認済みにもしない。
- 緊急停止の新しい確認は別の管理操作 `confirm-quorum-emergency.mjs`。計画checksum承認が必要。
- その後のみ、管理権限を持つ人の明示的な`/spamprotection auto on`で新Epochの同意を確定できる。
- `auto off`は明示OFFを保存し、再起動や他の設定変更でも維持する。旧同意行は変更しない。
- 未確認の運営Roleは権限に使用しない。Owner/Administratorの明示add/removeで新EpochのRole設定を確定する。
- 未確認のログ先では、公開channelへのFallbackをしない。Owner/Administratorの明示set/off後だけ使用する。
- Timeout直前の新鮮な再確認・一意Claim・24時間仕様・UNKNOWN管理を保持。

## 初回2票Bootstrapと自動フェイルオーバー

固定voterはNeon/Supabase/Tursoのまま。ping成功を権威にしない。
新EpochのprefixはepochのSHA256から導出した`nvq_<16hex>_`。membership / acceptor / archive shardを別テーブルに保存する。
旧表・旧同意・既存Audit/OutboxをDROP/UPDATE/TRUNCATE/DELETEしない。
prefix衝突でもmembership/epoch不一致を拒否し、既存データを上書きしない。

新規Supabase/Tursoを**明示承認で2票だけ初期化**し、全旧Writerの外部封鎖記録を同じ2票の移管Manifestへ確定。
Guildごとに旧値を使わず未確認レコードを作る。RuntimeはManifest/checksumと同じEpochを要求する。
稼働開始後のread/writeは既存Paxos prepare/accept/CAS。Neon障害で特別な切替操作は不要、残る正常2票で継続する。
2票を失えば拒否する。SQLiteを代わりの票に数えない。

Neonは初回quarantine。Quota回復・旧バックアップ復元だけでは新Epochへ投票できない。
新しいprefix/membershipを準備し、残る元の2票から`rejoinVoter`で全namespaceを照合・再同期する。
古いNeonの旧表を新しい状態へコピーしない。矛盾した履歴は隔離し、推測mergeしない。
検証後のみ全Writerで`SECURITY_COORDINATOR_RECOVERY_NEON_REJOIN_APPROVED=<epoch>`とquarantine設定を承認変更する。
この値は検証作業の代用品ではない。無断DB rollback/Byzantine改ざんは保証対象外。

## Snapshotなしでも残る必須条件

Snapshotは不要だが、**旧Writerの排他は省略しない**。
停止したつもりのBotや到達不能の旧DBをフェンスとみなさない。

1. 全Bot/Web/CLI/別ホスト/旧Deployment/boot再起動経路を棚卸し。
2. 正常な既存SQLite/WAL、Audit、Incident、Outbox、News履歴を整合backupし、隔離restoreを確認。秘密情報はprivate保存。
3. 新しい配置を準備してから、旧Botの処罰と配送をdrain。旧Web/CLI書込みと再起動経路も停止。
4. 旧SQL Writerの資格情報を無効化または同等に封鎖し、再接続でも旧権威へ書けないことを確認。
   NeonがSQL不可なら、管理面で資格情報/接続経路を封鎖できるか確認する。できなければBootstrapしない。
5. 作業者がfence証跡・復元証跡を検証し、計画と結合した承認Artifactを作る。コードはこの証明を自動発行しない。

証明には`allWritersInventoried / discordPunishersDrained / legacySqlWriteAccessRevoked / oldDeploymentsFenced /
localStateRestorable / legacyDataRetained`、24時間以内のverifiedAt、backupとfence記録のchecksumを要求する。
これは信頼された運用者の外部証明であり、自己申告booleanから未知のホスト停止を証明する仕組みではない。
今回の本番は専用Supabase DB未用意。Authと同居する既存同期DBへ新テーブルを作らない。

## 管理手順

計画JSON: `version=1`, 新`epoch`, `cutoverId`(32hex), `controlId`(Bot Application ID),
`retiredEpochs`(旧権威の識別ラベル、旧Quorumがなければlegacy-neon-v2), 実参加Guild一覧`guilds`,
`sourceState=unconfirmed`, `schemaChecksum=checksum(recoverySchema(epoch))`。
計画・証跡はprivate/local専用。Secretを含めず、Gitへ追加しない。

`node scripts/bootstrap-unconfirmed-quorum.mjs --plan=<absolute-path> --print-schema`
はPLAN_ONLY、DBに接続せず予定DDLと計画hashを提示する。

証跡・バックアップ実ファイルhashが一致し、`SECURITY_QUORUM_RECOVERY_APPROVED=<plan checksum>`を明示設定した場合のみ:

`node scripts/bootstrap-unconfirmed-quorum.mjs --plan=... --evidence=... --backup=... --fence-record=... --install-reviewed-schema --execute-reviewed-recovery`

管理操作だけが新prefixへのadditive DDLを実施。Supabase/Tursoだけが対象で、旧Neon SQLは使わない。
途中失敗は元の同一計画で再開。既に管理者が確定した新設定を未確認に戻さない。自動削除なし。
この手順では旧17件のMigration runnerを一括実行しない。無関係pending Migrationを混ぜない。

Bot/Web共通の設定名（値はSecret保存先へ。接続文字列は出力しない）:

- `SECURITY_COORDINATOR_MODE=quorum`
- `SECURITY_COORDINATOR_EPOCH=<new epoch>`
- `SECURITY_COORDINATOR_TABLE_PREFIX=<derived prefix>`
- `SECURITY_COORDINATOR_RECOVERY_CONTROL_ID=<controlId>`
- `SECURITY_COORDINATOR_RECOVERY_PLAN_CHECKSUM=<plan hash>`
- `SECURITY_COORDINATOR_SUPABASE_URL=<non-Auth dedicated connection>`
- 既存Turso URL/Token、Neon URL（復帰まではquarantine）

復旧中はlocal Auto executionも無効化し、CloudとRuntime両方で抑止する。
Owner移管には#43の既存drain/owner CAS手順を別途実施。Workerは配送先・保持条件・配置を維持して必要最小限に更新する。

## UIの期限とニュース

Guild一覧・設定GET・保存PUTはヘッダー/JSON本文を含め8秒の有限待ち。Abort非対応の通信でも待ち続けない。
古いGuildリクエストの結果・エラーを表示しない。unset/unconfirmed/unavailableを分け、保存成功を偽らない。
Web runtime初期化失敗Promiseは固定cacheせず、復旧後に再試行可能。

ニュースは同じ新Epochに結合。配信先未確認を表示し、推測して配信しない。
旧Epochで作成したpublicationはpauseし、Claimのない新Epochで再送しない。新Epochの新Newsのみ、明示設定と通常の最終確認後に配送可能。
News ID、SQLite Claim/Audit/Outbox、UNKNOWN再送禁止を保持。実Guildへ試験ニュースを送らない。

## 検証範囲と切り戻し

2026-10-26のローカル検証: 全体870 PASS / 14 SKIP / 0 FAIL、隔離PostgreSQL＋Turso SDK 47 PASS、実DB再起動2 PASS。
Build / TypeScript / Syntax（275 modules）/ Migration checksum / Secret scanはPASS。Lintは既存8 warnings、0 errors。
空のgitignored `.env.local`はBackup DryRunの存在条件のためだけに使用し、検証後削除。Production資格情報は使用しない。
依存監査はProduction依存 Critical 0 / High 5 / Moderate 2 / Low 1。開発依存込みではCritical 1 / High 28 / Moderate 32 / Low 7。
Criticalは既存shadcn経由のproxy-addr（GHSA-jqcg-44mw-7w3h、dev-only）。依存3ファイルはpatched mainと同一で、今回増やした依存ではない。別Security課題として扱い、本変更へ無関係な更新を混ぜない。
Secret scanは変更ファイルの検出0、Discord token検出0。全source inventoryの7件は既存コード/ダミーテストに同一内容で存在する検出で、今回のSecret追加ではない。

実SQLite、実PostgreSQLとTurso SDKのlocalhost Hranaで隔離検証。Hosted Supabase/Tursoの耐久性・分断試験とは区別する。
既存Auth/Session、Analytics/Notifications/Goals等の全Neon直結テーブルを汎用SQL Proxy化した機能ではない。
今回の対象はSecurity設定/同意/権限/ログ先/ニュースの共通Control Plane。その他の履歴は既存Local-First/Projection契約に従う。

切替前は現行Productionを維持。切替後の問題は新Epochを維持した安全な対応版へ戻す。
未確認状態を残し、処罰/新規配送を止め、旧Writerの資格情報・旧Botを無保護に戻さない。
新データを旧Snapshotで上書きするRollbackは禁止。停止時間は旧Writer drainから新Bot接続まで必要で、Hosted準備前に止めない。
