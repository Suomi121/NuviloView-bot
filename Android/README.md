# NuviloView Android / Termux Runtime

## 構成

Android再起動後も、Discord BotとSQLite Outbox Sync Workerを互いに独立して監視する構成です。Next.js WebはAndroidでは起動しません。

```text
Android boot
└─ Termux:Boot
   └─ ~/.termux/boot/nuviloview.sh       (薄いwrapper)
      └─ Android/boot-start.sh            (起動司令塔・常駐しない)
         ├─ Android/run-bot-forever.sh
         │  └─ discord-bot.mjs
         └─ Android/run-sync-worker-forever.sh
            └─ scripts/run-sync-worker.mjs
```

BotとWorkerは別PID、別lock、別Backoffです。一方の異常終了や停止はもう一方を再起動しません。WindowsとAndroid間のCross-Host Singletonはこの構成では変更していません。同じBot Tokenを使う複数ホストを同時起動する場合は、既存のDistributed Singleton設定が正しく有効化・検証済みである必要があります。

## 必要なアプリとバージョン

- Termux
- Termux:Boot（Termux本体と同じ配布元）
- 任意: Termux:API（wake lockを使う場合）
- Node.js 24.x
- package.json指定のpnpm 11.22.0
- Git、procps、coreutils、findutils、sed

古いPlay Store版ではなく、Termux公式が案内する配布元を利用してください。Termux、Termux:Boot、Termux:APIは署名を揃えるため同じ配布元から導入します。

## 初期セットアップ

Repositoryは`$HOME`以下のTermux private storageへ配置します。`/sdcard`、`/storage/emulated/0`、Download、Documents、`~/storage`配下では起動を拒否します。

```bash
pkg update
pkg install nodejs-lts git procps coreutils findutils sed
cd "$HOME/NuviloView-bot"
chmod +x Android/*.sh
./Android/setup-termux.sh
```

`setup-termux.sh`はpackage.jsonに指定されたpnpm版を使用し、既存lockfileから依存関係を導入します。Git pull、branch切替、Auto Updateは行いません。

秘密情報はプロジェクトルートの`.env.local`だけに置き、権限を`600`にします。値をREADME、コマンドライン引数、シェル履歴、ログへ書かないでください。

```bash
chmod 600 .env.local
```

現行の`discord-bot.mjs`にはまだNeon PrimaryのLegacy domainがありますが、Bot起動に必須なのはDiscordの`NUVILOVIEW_CLIENT_ID`と`NUVILOVIEW_BOT_TOKEN`です。`DATABASE_URL`が未設定またはNeonが到達不能の場合、Botは明示的な`DEGRADED`モードでDiscord Gatewayへ接続し、Cloud-only機能だけを停止します。Legacy Message保存が選択されているGuildでは保存先が`UNAVAILABLE`と表示され、勝手にLocal-Firstへ切り替わりません。

NeonへのQueryは共通Guardを通り、障害検知後は指数Backoff中のネットワークアクセスを抑止します。`Android/status-nuviloview.sh`でRuntime Mode、Neon、Message Storage、Cross-Host Leadershipを確認できます。Distributed Singletonが有効なのにNeon Leaseを確認できない場合だけは、Discord二重接続防止のため従来どおりfail-closedです。

## Termux:Bootの導入

1. Termux:Bootアプリを一度手動で開きます。
2. Termuxでinstallerを実行します。
3. 状態を確認します。
4. 実端末の再起動はユーザーが手動で行います。

```bash
cd "$HOME/NuviloView-bot"
./Android/install-termux-boot.sh
./Android/status-nuviloview.sh
```

installerは`~/.termux/boot/nuviloview.sh`を冪等に生成します。wrapperには起動呼び出しとログ転送だけを置き、TokenやDB URLは書きません。再実行しても同一内容を重複追加しません。

解除する場合:

```bash
./Android/install-termux-boot.sh --remove
```

## 基本操作

```bash
# Node、node:sqlite、pnpm、設定、SQLite、空き容量を診断
./Android/termux-preflight.sh

# Boot相当の手動起動（BotとWorkerを個別起動）
./Android/boot-start.sh

# 全体状態
./Android/status-nuviloview.sh

# Bot → Workerの順でgraceful stopし、wake lockを解放
./Android/stop-nuviloview.sh
```

個別操作も可能です。

```bash
./Android/run-bot-forever.sh --validate-only
./Android/run-bot-forever.sh --once
./Android/run-bot-forever.sh --status
./Android/run-bot-forever.sh --stop

./Android/run-sync-worker-forever.sh --validate-only
./Android/run-sync-worker-forever.sh --once
./Android/run-sync-worker-forever.sh --status
./Android/run-sync-worker-forever.sh --stop
```

`SYNC_WORKER_ENABLED=false`ならWorkerは`DISABLED`として正常終了し、Botだけを起動できます。有効時は`SYNC_NEON_REPLICA_ENABLED`、Local Storageのread/write、`DATABASE_URL`が必要です。Neon接続断はWorker内部でretry/circuit openとなり、Bot Runnerを停止しません。

## PreflightとSQLite診断

Boot時は短い初期待機後、Preflightを有限回だけ再試行します。

- Project/private storageと必須ファイル
- Node.js 24、`node:sqlite` import
- SQLite open、rollback write probe、quick integrity、WAL
- SQLite DB/WALサイズ、端末空き容量
- pnpm 11.22.0との一致
- envの存在・権限とFeature Flag矛盾
- log/PIDディレクトリの書き込み
- Termux:Bootとwake lockコマンドの有無
- 低コストなOS route状態（利用可能な場合のみ）

判定は`PASS`、`WARN`、`FAIL`です。ネットワーク不明・Neon未接続・wake lockコマンド不在は、それだけでBoot全体の`FAIL`にはしません。一方、Message Local-FirstがONなのにSQLiteがOFFなどの矛盾、SQLite不健全、致命的な空き容量不足は`FAIL`です。データを自動削除する処理はありません。

## PID、再起動、Crash Storm

状態は`Android/runtime/`へ保存します。

```text
runner.pid / bot.pid / runner.lock
sync-worker-runner.pid / sync-worker.pid / sync-worker-runner.lock
boot.lock
bot-runner.state / sync-worker-runner.state
```

PIDだけでなく`/proc/<pid>/cmdline`も照合し、stale PID/lockを回収します。BotとWorkerのBackoffは独立しています。短時間に既定5回クラッシュした場合は15分の`COOLDOWN`へ入り、その後再試行します。安定稼働後はBackoffとCrash履歴をリセットします。通常停止はSIGTERMを使い、猶予後にも子プロセスが残る場合のみ孤児化防止の最終手段としてSIGKILLを使います。

## Wake LockとAndroid省電力

`termux-wake-lock`があればBoot時に取得し、`stop-nuviloview.sh`が`termux-wake-unlock`を試します。コマンドがない・取得に失敗した場合は警告だけで起動を続けます。

Android設定では次を確認してください（名称は機種ごとに異なります）。

- TermuxのBattery Optimization除外
- バックグラウンド実行許可
- メーカー独自の自動起動許可
- Wi-Fi/モバイル通信・データセーバーの例外
- Termux:Bootのバックグラウンド許可

Wake LockやRunnerがAndroid OSによる強制終了を完全に防ぐ保証はありません。OS更新後も設定を再確認してください。

## Logs

```text
Android/logs/termux-boot.log
Android/logs/bot-runner.log
Android/logs/bot-output.log
Android/logs/token-leak-check.log
Android/logs/sync-worker-runner.log
Android/logs/sync-worker-output.log
```

既定で10 MiBごとにローテーションし、14日保持します。envから読み込んだToken、Secret、Password、API Key、DB URLとURL内Passwordは`[REDACTED]`へ置換します。Message本文をRunner自身が追加出力することはありません。

## Troubleshooting

### WorkerがDISABLED

`SYNC_WORKER_ENABLED=false`なら正常です。Botは独立して稼働します。

### Circuit OPEN / Neon unavailable

WorkerはBackoffし、Circuitが再試行可能になるまで待機します。高速な手動再起動やHealth Query連打は不要です。BotのLocal-First Message保存とSQLite Outboxは継続しますが、未移行のLegacy Bot domainはNeon障害の影響を受ける可能性があります。

### `node:sqlite` unavailable

`node --version`が24.xであることを確認してください。診断は別native driverを勝手に導入しません。

### `Permission denied` / `bad interpreter`

```bash
chmod 700 Android/*.sh
chmod 600 .env.local
sed -i 's/\r$//' Android/*.sh
```

### 実端末Reboot test

先に`boot-start.sh`によるBoot相当テストと`status-nuviloview.sh`を確認してください。Codexやscriptから実端末を勝手に再起動しません。準備後にユーザーがAndroidを再起動し、`termux-boot.log`とStatusを確認します。

## Auto Update

このRuntimeにはAuto Updateを実装していません。Boot経路で`git fetch`、`git pull`、`git reset`、branch切替、`pnpm update`は実行されません。更新機構は別Phaseで設計・検証します。
