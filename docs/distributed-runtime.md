# NuviloView Distributed Runtime

NuviloViewのDiscord Botは、PostgreSQL / Neonの期限付きLeaseを使って、Windows、Android / Termux、Renderなど複数Hostから同じProduction Botが同時接続することを防ぎます。同一Host内のPID lockやWindows Mutexも、早い段階での重複防止として引き続き使用します。

## 起動順

1. 環境設定を検証
2. Databaseへ接続
3. `service_lease`を原子的に取得
4. `service_heartbeat`へ`Starting`を記録
5. Lease更新とheartbeatを開始
6. Discordへログイン
7. Discord Ready後に`Running`へ変更

Leaseを取得できないProcessはDiscordへログインせず、終了コード`20`で終了します。Windows / Android runnerはこれをCrashと区別し、5分待ってから再確認します。

## Identity

- `serviceKey`: deployment単位の安定した識別子。同じProduction Botを動かす全Hostで一致させます。
- `hostId`: Host単位の安定した識別子。秘密値やIPアドレスを使わないでください。
- `instanceId`: Process起動ごとに生成されるUUIDです。
- `fencingToken`: Owner交代時にDB上で原子的に増加します。古いProcessのrenewとreleaseは拒否されます。

推奨設定：

```env
NUVILOVIEW_DISTRIBUTED_SINGLETON=true
NUVILOVIEW_SERVICE_KEY=nuviloview.discord-bot.production
NUVILOVIEW_LEASE_TTL_SECONDS=45
NUVILOVIEW_LEASE_RENEW_SECONDS=15
NUVILOVIEW_HEARTBEAT_SECONDS=15
```

Hostごとの値：

```env
# Windows
NUVILOVIEW_HOST_ID=windows-main

# Android / Termux
NUVILOVIEW_HOST_ID=nuvilo-android

# Render
NUVILOVIEW_HOST_ID=render-production
```

ProductionとStagingは異なるservice keyを使用します。

```env
NUVILOVIEW_SERVICE_KEY=nuviloview.discord-bot.staging
```

## Lease failure behavior

- Acquire競合：Discordへ接続せず終了コード`20`
- Lease喪失：Critical log、Discord切断、`LeaseLost` heartbeat、終了コード`21`
- 設定不正：Discordへ接続せず終了コード`22`
- 起動時DB障害：Discordへ接続せず終了コード`23`
- 稼働中DB障害：既知のlease期限まではrenewを再試行し、安全期限までに所有権を証明できなければ切断
- 正常終了：Discord切断後、自分のinstanceIdとfencing tokenが一致する場合だけrelease

判定にはDBの`CURRENT_TIMESTAMP`を使います。DBから返された残り時間は単調時計へ変換するため、Host間の時計ずれでtakeover判定が壊れません。

## External Operations Monitor

Botとは別Processで起動します。Discord Bot Tokenは不要です。

```powershell
pnpm monitor:runtime:once
pnpm monitor:runtime
```

`monitor:runtime:once`は1回確認してJSONを出力します。`monitor:runtime`は30秒間隔で監視します。監視Processは、Botと同じPCやAndroidだけではなく、独立したHostで動かしてください。

Singleton展開前は`NUVILOVIEW_MONITOR_EXPECT_SINGLETON=false`で既存`bot_heartbeat`を観測できます。全Hostで有効化した後に`true`へ切り替えます。

監視対象：

- Lease ownerの有無と期限
- OwnerとheartbeatのinstanceId / fencing token一致
- heartbeat遅延・停止
- freshな非Owner Process
- 同一hostIdの複数Process
- 10分間に5回以上の再起動
- 繰り返すLease競合
- Owner世代のflapping
- DB接続不能
- DB probe latency
- Discord Ready、disconnect/reconnect、invalid session、login failure、REST rate limit
- Web monitor API status、認証失敗、latency
- 最新Backup status、age、destination degradation、restore verification
- Open Critical / repeated High Security incidents
- Analytics inventoryの成功・失敗とfreshness

通知状態はローカルの`data/runtime-monitor/state.json`に保存し、fingerprintが変化したときだけ`INFO` / `WARNING` / `CRITICAL`通知を送ります。同じ障害は重複通知せず、正常化時は`RECOVERY`を一度送ります。Webhook、monitor token、Database URLはログやstateへ保存しません。

Monitorには可能なら`service_lease`と`service_heartbeat`だけをSELECTできる専用DB Roleを使用してください。Webhook通知が不要な場合、Databaseへの書き込み権限は不要です。

## Developer diagnostics

- `GET /api/developer/runtime/lease`
- `GET /api/developer/runtime/heartbeats`

どちらも既存のDiscord開発者ID認証とrate limitを使用します。公開monitorの`/api/monitor/bot`は詳細を返さず、正しいmonitor tokenがある場合だけ`ok`または`down`を返します。

Developer ConsoleにはCurrent Owner、instance、fencing token、heartbeat age、Host履歴が表示されます。Force Releaseは実装していません。

## Safe rollout

1. Botを1台だけ稼働させた状態で`pnpm db:migrate`
2. VercelへWeb/APIを反映
3. 外部Monitorをread-onlyで確認
4. 現在の1 Hostへ固有`NUVILOVIEW_HOST_ID`を設定しsingletonを有効化
5. heartbeatとDeveloper ConsoleがHealthyになることを確認
6. 他Hostにも同じservice keyと固有hostIdを設定
7. `npm run test:runtime:failover`でProduction service keyとDiscord Tokenを使わない実DBfencingリハーサルを実施
8. Android primary / Windows standbyの実機停止・復帰試験を実施し、結果を保存

全HostでMigration完了前にfeature flagを有効化しないでください。

## Rollback

1. 新しいHostを起動せず、現在のOwnerを正常停止
2. 全Hostで`NUVILOVIEW_DISTRIBUTED_SINGLETON=false`
3. Botを1 Hostだけ再開
4. 外部Monitorを停止
5. 必要な場合だけ`20260816-distributed-runtime.down.sql`を手動実行

Rollback SQLは新規2テーブルだけを削除します。既存の`bot_heartbeat`、Analytics、Guild、認証データには触れません。
