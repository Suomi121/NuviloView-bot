# NuviloView Android / Termux Bot Host

## 1. 概要

Androidスマートフォンを、NuviloView Discord Bot専用の簡易ホストとして利用するための構成です。AndroidではTermux上のNode.jsで既存の`discord-bot.mjs`だけを動かします。Next.js WebアプリはAndroidでは起動しません。

## 2. 構成

```text
Vercel            = Webダッシュボード
Neon              = PostgreSQLデータベース
Android / Termux  = Discord Bot
```

Windows版の`scripts/run-bot-forever.ps1`は変更せず、そのまま共存します。WindowsとAndroidは同じ`discord-bot.mjs`を使用します。

> **重要:** 同一Bot Tokenを使うWindows版とAndroid版を同時起動しないでください。Gateway Session競合、イベントの重複処理、DBの重複書き込みにつながる可能性があります。移行時は「Windows Bot停止 → 停止確認 → Android Bot起動」の順に行ってください。

## 3. 必要条件

- Android端末
- 現在提供されているTermux
- Node.js 24.x（プロジェクトの`engines`に一致する版）
- Git
- pnpm 10
- 常時インターネット接続
- NuviloViewソースコード
- プロジェクトルートの`.env.local`

古いPlay Store版を前提にしません。[Termux公式のInstallation案内](https://github.com/termux/termux-app#installation)で配布状況を確認し、通常はF-Droidまたは[公式GitHub Releases](https://github.com/termux/termux-app/releases)を利用してください。Termux本体とTermux:Boot / Termux:APIは署名を揃えるため、必ず同じ配布元から導入します。特定の最新版番号には依存しません。

## 4. Termuxセットアップ

最初に必要なパッケージを用意します。

```bash
pkg update
pkg install nodejs-lts git procps coreutils findutils sed
```

`pnpm`がない場合、`setup-termux.sh`がcorepackまたはnpmを使ってpnpm 10を導入します。

## 5. Repository配置

RepositoryはTermuxのprivate storage、通常は`$HOME`配下へ配置してください。

```bash
cd "$HOME"
git clone <NuviloView repository URL> NuviloView
cd "$HOME/NuviloView"
```

`.env.local`とBot Tokenを次の場所へ置かないでください。

- `/sdcard`
- `/storage/emulated/0`
- AndroidのDownload / Documents
- `~/storage`から参照できる共有領域

共有ストレージ上のRepositoryはランナーが起動を拒否します。

## 6. 初期セットアップ

```bash
cd "$HOME/NuviloView"
chmod +x Android/*.sh
./Android/setup-termux.sh
```

秘密情報はプロジェクトルートの`.env.local`だけから読み込みます。最低限、次の変数が必要です。

```dotenv
DATABASE_URL=
NUVILOVIEW_CLIENT_ID=
NUVILOVIEW_BOT_TOKEN=
```

値をREADME、Git、シェル履歴、コマンドライン引数へ書かないでください。`.env.local`には`chmod 600 .env.local`を設定します。

## 7. Validate

Botを起動せず、Node.js、pnpm、依存関係、env、必須ファイル、書き込み権限、lock、Token漏洩チェックを確認します。

```bash
./Android/run-bot-forever.sh --validate-only
```

## 8. テスト起動

Botを1回だけ起動します。終了しても再起動しません。

```bash
./Android/run-bot-forever.sh --once
```

`Ctrl+C`でSIGINTを送り、Botのgraceful shutdownを確認できます。

## 9. 常駐起動

```bash
./Android/run-bot-forever.sh
```

異常終了時は5秒、15秒、30秒、1分、2分、5分、10分、15分の順で再起動待機を増やします。5分以上正常稼働するとBackoffをリセットします。

## 10. Wake Lock

Termux:APIが利用可能な場合、次のコマンドでスリープ中もCPUを維持しやすくできます。

```bash
termux-wake-lock
```

必要に応じてTermux:APIアプリとTermux側パッケージを、Termux本体と同じ配布元から導入してください。コマンドが利用できなくてもBot起動は継続されます。停止後に解除する場合は次を実行します。

```bash
pkg install termux-api
```

```bash
termux-wake-unlock
```

## 11. Battery Optimization

Android設定で以下を確認してください。名称はAndroidバージョンやメーカーで異なります。

- Termuxをバッテリー最適化の対象外にする
- バックグラウンド実行制限を解除する
- 自動起動を許可する
- スリープ中もWi-Fi接続を維持する
- データセーバー利用時もTermuxの通信を許可する

Samsung、Xiaomi、OPPO、vivo、Huaweiなどは独自のタスクキラーや省電力設定が強い場合があります。「制限なし」「バックグラウンド許可」「自動起動」などの設定も確認してください。OS更新後に設定が戻っていないかも確認が必要です。

## 12. Termux:Boot

Termux:BootをTermux本体と同じ配布元から導入し、一度アプリを開きます。その後、薄いwrapperを作成します。

```bash
mkdir -p "$HOME/.termux/boot"
printf '%s\n' '#!/usr/bin/env bash' 'exec "$HOME/NuviloView/Android/boot-start.sh"' > "$HOME/.termux/boot/nuviloview.sh"
chmod 700 "$HOME/.termux/boot/nuviloview.sh"
```

Repositoryの配置名を変更した場合は、wrapper内の`$HOME/NuviloView`だけを実際のパスへ合わせてください。`boot-start.sh`はwake lockを試行し、既存ランナーを確認してから常駐ランナーをバックグラウンド起動します。

## 13. 停止

正式な停止方法は次のとおりです。

```bash
./Android/run-bot-forever.sh --stop
```

ランナーへSIGTERMを送り、ランナーからBotへSIGTERMを転送します。BotはDiscord接続やタイマーを閉じて終了します。wake lockを取得していた場合は、停止後に`termux-wake-unlock`も実行してください。

## 14. Status

```bash
./Android/run-bot-forever.sh --status
```

Runner PID、Bot PID、起動日時、最新のrunner logを表示します。PIDファイルだけでなく実際のプロセス引数も照合します。

## 15. ログ

ログはすべてTermux private storage内の`Android/logs/`へ保存します。

```text
Android/logs/bot-runner.log
Android/logs/bot-output.log
Android/logs/token-leak-check.log
Android/logs/boot.log
```

Runner / Bot / Token checkログは10MBでローテーションし、archiveを14日間保持します。ログ確認例:

```bash
tail -n 100 Android/logs/bot-runner.log
tail -n 100 Android/logs/bot-output.log
```

Token、Client Secret、OAuth Secret、API Key、DB URLとPasswordは既知のenv値およびDB URL形式を使って`[REDACTED]`へ置換します。意図的に秘密値をログへ出力しないでください。

## 16. 更新

Bot稼働中にファイルを入れ替えないよう、次の順に更新します。

```bash
cd "$HOME/NuviloView"
./Android/run-bot-forever.sh --stop
git pull --ff-only
pnpm install --filter nuviloview-oem --frozen-lockfile
./Android/run-bot-forever.sh --validate-only
./Android/run-bot-forever.sh
```

WindowsからAndroidへ移行する場合も、先にWindows版を停止してDiscord上のBotがofflineになったことを確認してください。

## 17. Troubleshooting

### `node: command not found`

`pkg install nodejs-lts`を実行し、`node --version`がプロジェクト指定の24.xであることを確認します。

### env / Bot Token missing

`.env.local`がRepositoryルートにあり、`DATABASE_URL`、`NUVILOVIEW_CLIENT_ID`、`NUVILOVIEW_BOT_TOKEN`が空でないことを確認します。値自体はログへ表示されません。

### `Permission denied`

```bash
chmod 700 Android/*.sh
chmod 600 .env.local
```

### CRLF / `bad interpreter`

Repositoryでは`Android/*.sh`をLF固定しています。手動コピーでCRLFになった場合は、Termux上で次を実行します。

```bash
sed -i 's/\r$//' Android/*.sh
```

### Bot二重起動

`--status`でPIDを確認してください。停止済みPIDなら次回起動時にstale lockを自動回収します。稼働中のRunnerを強制的にlock削除して回避しないでください。

### Discord Session Start Limit

ログにSession Start Limitが検出された場合、既知のreset時刻または15分のfallbackまで待機します。高速な再接続は行いません。Windows版Botが同時起動していないことも確認してください。

### AndroidがTermuxをkillする

Battery Optimization、バックグラウンド制限、自動起動、メーカー独自タスクキラーを見直し、Termux:Bootとwake lockを設定します。Android OSによる強制終了をスクリプトだけで完全に防ぐことはできません。

### wake lock unavailable

Botは起動を継続します。必要な場合だけTermux:API環境を追加し、`command -v termux-wake-lock`で確認します。

### Neon接続失敗

`DATABASE_URL`の設定、Neonプロジェクトの稼働状態、Androidの時計、TLS対応Node.js、ネットワーク接続を確認してください。接続文字列をログや問い合わせへ貼らないでください。

### DNS / network failure

ブラウザで通信できるか、Private DNS / VPN / Wi-Fi制限がないかを確認します。障害中はBackoffが働くため、手動で高速再起動を繰り返さないでください。
