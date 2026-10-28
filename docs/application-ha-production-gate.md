# Application HA: production gate (2026-10-28)

**NO-GO. Production操作の承認をまだ求めない。** #47はDraftのまま。内部のImport/全文検索/全DB削除が未完成で、外部DBだけを用意しても全体完成にはならない。

追加ブロッカー: 2026-10-28の再監査でProduction依存Critical 1（Better Auth / GHSA-965c-763c-88jm）。成立に必要なMagic Linkプラグインは現行コードでは未使用だが、auditはFAIL。監査Gateを除外せず、公式修正版の供給確認と別途Auth回帰検証を必要とする。

## 必要な専用DB

- Auth専用Supabaseと別ProjectのPostgreSQL。`user/account/session`が存在するDBは使用禁止。
- 固定投票者はNeon/Supabase/Tursoの3系統。Supabase/Tursoの2系統を新Epochで初期化し、旧Neonは隔離したままとする。
- 新Supabaseに必要なものは`recoverySchema(epoch)`が返すEpoch固有prefixのmembership/acceptor/blob shardテーブルとそのPK/制約だけ。既存Authテーブルを変更しない。
- 構築/DDL用資格情報とRuntime DML用資格情報を分ける。Runtimeは対象prefixへのSELECT/INSERT/UPDATE、移管時のDDLは別の管理経路。削除ツールの権限は通常Runtimeへ追加しない。
- 接続情報は既存Secret管理へ保存する。チャット/CLI引数/履歴/レポートへ出さない。作成・Secret追加・課金は今回は未実施。
- `SECURITY_COORDINATOR_SUPABASE_URL`と`WEB_AUTH_SUPABASE_DATABASE_URL`のDB identity比較を必須とする。文字列一致だけでなくSupabase poolerのProject refも照合する既存runtime検証を維持。

## 切替前に固定するもの

1. Botの実PID/cwd/HEAD、全Worker/Supervisor、Web現行/過去Deployment、ローカル手動スクリプト、外部CIのWriter一覧。
2. 旧Writerの停止・SQL書込権限失効・古いDeployment封鎖・Discord旧punisher排出の証拠。Ping失敗は封鎖証明ではない。
3. SQLite/WAL・Outbox・Queue/DLQ・Audit・環境設定の復元可能なバックアップ。Secretを一般artifactへ混入しない。
4. 同一新Epoch/control ID/prefix、固定membership、アプリ暗号化key/key ID、Publisher ID/sourceEpoch。鍵の復元検証も必要。
5. 不明な旧値はunconfirmed。Auto Timeout/緊急停止/運営Role/Blocklistを許可と推測しない。17というGuild数を固定せず、切替時の実在Guild一覧をレビューする。

## 予定順序（今回は実行しない）

内部3ブロッカー完成 → 統合CI → 専用Hosted DB隔離接続/永続化/障害/restore試験 → Snapshotまたは新Epoch未確認復旧planのレビュー → 切替対象/停止時間/復元手段を報告し最終承認 → バックアップ → 全旧Writer封鎖 → 新Epoch DDL/Quorum初期化 → Bot/Web/Workerを同一リリースへ切替 → 読取/設定状態/Discord非破壊Smoke → Queue/Retry/DLQ/Quorum監視。

旧設定の完全復元は前提にしないが、未確認状態・新たな明示判断・旧バックアップの値を混ぜない。

## 中断/復旧

- Auth DBへの誤接続、membership/Epoch不一致、旧Writer未封鎖、失われた暗号化key、Quorum不足、競合/破損、UNKNOWNの誤再送があれば次段階へ進まない。
- 切替中断時は副作用を停止し、新Epochの確定記録を保持する。旧Writerをそのまま再開しない。旧版へ戻す場合も新Epoch/fenceを理解する安全版だけを使用する。
- ローカルPostgreSQL/Turso SDKの成功をHosted試験成功へ読み替えない。現時点で専用Supabase・Hosted故障/restore・実Discordは未検証。
