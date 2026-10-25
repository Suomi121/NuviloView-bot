# s?news 自動配信先（PR #43依存 / 本番未反映）

基準: `feat/hybrid-multi-db` / `12e5bd90b2f8495257336aea15b0e0ec3db97f66`。
既存の開発者ID Gate・DM・Modal・確認・キャンセル・UNKNOWN再送禁止は維持する。

## 選択と確認

1. 明示設定先が現在送信可能なら、それを使用。
2. 未設定、または明示先が送信不能なら、送信可能候補の正の活動量最大を選ぶ。
3. 活動がゼロ・取得不能・古い場合は、候補の数値Channel ID最小を選ぶ。
4. 確認できた候補がなければ未配信。チャンネル一覧取得失敗と、全候補送信不能は別理由を記録する。

同数も数値ID順。名前・topic・position・用途・System/Announcement指定は順位に使用しない。
種類はAPI送信能力の確認にのみ使用する。音声/Stageのテキスト、使用可能なactive threadも候補。
Thread作成・参加・アーカイブ解除・crosspostはしない。
明示先が無効な場合の自動候補は確認画面で開示し、明示設定そのものを書き換えない。

全Guild一覧はDiscord APIから取得（17固定ではない、既存上限10,000）。
候補一覧はDM内8件/ページで全件確認できる。対象・可能/不能数・選択理由とチャンネルIDを表示する。
計画時の本文、Guild、チャンネル、設定Revision/Checksum/Epoch、選択根拠を固定し、計画Hashで検証する。
確認待ち中の明示設定変更は計画を無効化し、再計画を要求する。
Quorum移管前のローカル明示設定が残る場合は未設定と推測せず、移管が必要として拒否する。

配送前に現在のGuild所属・チャンネル存在・Bot本人・Role・権限を再確認する。
確認後に削除/権限剥奪/設定変更があれば失敗理由を保存し、別チャンネルへ変更しない。
閲覧・Embed Links・Send Messages（ThreadはSend Messages in Threads）が必要。
Read Message Historyは必須にしない。取得可能な履歴は重複の肯定的検出補助であり、不在は未送信の証明にならない。

## 活動データと限界

既存Local-First SQLite `message_event_log`を再利用。追加テーブル・Migrationなし。
Guildを限定し、現在から7日間のlive/createをChannel別に `COUNT(DISTINCT message_id)`。
payloadの`authorIsBot=false`かつ`isWebhook=false`をJSON booleanとして確認できる行だけを対象にする。
Webhook識別を新しい収集payloadへ追加。古い不変イベントを上書きしない。
識別情報のない古い行や、証明できないhistory importは人間の活動と推測せず除外する。
本文・ユーザー名・User IDを選択器へ渡さない。別Guildや未来日時も除外する。

範囲・生成時刻・観測時刻・件数を検証し、最新観測が24時間より古ければFallbackへ進む。
これは**ローカルで観測できた活動の順位**であり、Discord全履歴の完全な7日間カバレッジを保証しない。
再起動直後・収集停止・古いデータ移行中はデータ不足があり得る。確認画面に観測範囲を保持する。
メッセージ履歴の大量再取得はしない。10,000チャンネル超は切り詰めて誤順位を作らずFallback。

集計は専用read-only worker threadで既存SQLiteを開く。DB作成・DDL・書込み・クラウド接続なし。
Worker環境変数は空、受付上限3件、既定2秒期限、障害後60秒cooldown。失敗は活動不明としてFallback。
これは集計用スレッドであり、既存Sync Worker/Supervisorの変更ではない。
Interactionは集計やネットワーク待ち前にACKする。

## 永続化・Multi-DB

SQLiteの既存news状態/Audit/OutboxとPR #43の固定3票Coordinatorを維持。
計画はQuorumの設定Revision/Epochと結び、Claimも固定先と結び付ける。
Neonが停止/読取専用でも、初期化・同期済みSupabase/Tursoの2票が正しい状態を保持すれば準備とClaimが可能。
単なる接続成功やローカル初期値を合意とみなさない。未移管設定や不整合は拒否する。
SQLite障害や2票未達では配信しない。UNKNOWNは自動再送せず、再起動でも選択先を固定する。
429/403等の明確な拒否と5xx/timeout等の結果不明を混同しない。手動再送でも固定先のみ。
Discord exactly-onceを保証するのではなく、不明時に止めることで二重送信リスクを抑える。

## 検証・運用

実SQLite、隔離PostgreSQL、実Turso SDKのローカルHrana接続、Discord API Mockで検証する。
実Tursoクラウド障害、実Discord DM/表示/権限、Production Guildの候補は未検証。
チャンネル名・topic・system指定へのアクセスを例外にするMockで名前/用途の非依存を検証する。
設定・Slash Command・Migration・依存関係・Sync Workerへの変更なし。
本番有効化には、PR #43と本変更のレビュー、正式な設定移管、Runtime配置/保持条件の確認、別途リリース承認が必要。
今回は本番配信・設定変更・Deploy・再起動を行わない。
