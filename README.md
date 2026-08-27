# NuviloView:OEM

## Message History Import SQLite-First v3

Message History Import v3 stores Discord history and its durable checkpoint in
SQLite first. Raw message content stays local; existing Analytics Compaction
projections are the only History-derived data sent to Cloud replicas. The Web
retains only the bounded Job control metadata required for Start, Pause, Resume,
Cancel, Retry, Skip, Reset, and deletion requests. It remains disabled by
default and is explicitly limited to configured Canary Guilds.
See [docs/message-history-import-v2.md](docs/message-history-import-v2.md) for
the state model, privacy contract, retention, rollout, and rollback steps.

## Distributed Bot runtime

Windows、Android / Termux、Render間の同時Discord接続を防ぐPostgreSQL Lease、hostId / instanceId付きheartbeat、Botとは独立した外部Monitorを利用できます。初回は無効で、additive migrationと全Hostの設定を揃えてから有効化します。構成・導入・障害時の挙動は[docs/distributed-runtime.md](docs/distributed-runtime.md)を参照してください。

AndroidのTermux:Boot、Bot / Sync Worker独立監視、Preflight、停止・状態確認は[Android運用ガイド](Android/README.md)を参照してください。Boot経路にAuto Updateはありません。

## Multi-DB Sync v1

SQLiteをBot側の唯一のSource of Truthとして維持し、SupabaseとTursoへ
独立同期し、Neonを任意の第3Replicaとして扱うProvider分離基盤を利用できます。
全Flagは既定でOFFです。設計、Cloud Schema、reconciliation、段階的rolloutは
[Multi-DB Sync v1ガイド](docs/multi-db-sync-v1.md)を参照してください。

## Analytics Compaction v2

明示したCanary Guildでは、Message Raw EventをSQLiteだけに保持し、15分周期の
Current / Daily / Channel Daily / User Daily ProjectionだけをSupabase・Tursoへ
同期できます。既定値はOFFです。送信削減指標、Web countdown、History Importの
SQLite-first統合は[Analytics Compaction v2](docs/analytics-compaction-v2.md)を参照してください。

This is a [Next.js](https://nextjs.org) project bootstrapped with [v0](https://v0.app).

## Built with v0

This repository is linked to a [v0](https://v0.app) project. You can continue developing by visiting the link below -- start new chats to make changes, and v0 will push commits directly to this repo. Every merge to `main` will automatically deploy.

[Continue working on v0 →](https://v0.app/chat/projects/prj_eiBxpjsnGAlC0kjb2OYZlXr3wxbA)

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Windows Bot control

Double-click `NuviloView-Bot-Control.cmd` to open the local Bot control window.
It can start, stop, restart, and refresh the status of the PC-hosted Bot. Closing
the window does not stop the Bot. While the Bot is on, the existing runner keeps
automatic restart enabled.

The same window can be opened from a terminal:

```powershell
npm run bot:control
```

The controller never displays or returns the Bot token. Runtime PID and stop
request files are kept under the ignored `logs` directory. A normal stop asks
the Bot to disconnect and update its heartbeat before the runner exits.
Selecting off also writes an ignored persistent flag under `data/runtime`.
The Windows startup launchers respect this flag, so the Bot remains off after
a PC restart until on is selected again.

## Learn More

To learn more, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [v0 Documentation](https://v0.app/docs) - learn about v0 and how to use it.

## Server backups

`scripts/run-backup-forever.ps1` creates one verified server backup each day
and stores the same set on both `F:\NuviloView-Backups` and
`G:\NuviloView-Backups`. Backup sets are retained for 90 days.

Each set contains:

- a custom-format Neon/PostgreSQL dump;
- server source, configuration, tools, and runtime scripts;
- `.env.local` for disaster recovery;
- SHA-256 checksums and restore instructions.

Run a manual backup:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\backup-server.ps1
```

Verify a saved set without restoring it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify-server-backup.ps1 -BackupPath "F:\NuviloView-Backups\<BACKUP_ID>"
```

Because `.env.local` contains credentials, keep the existing file encryption
and ACL restrictions on both backup HDDs and restrict physical access. This
backup workflow does not require or enable BitLocker.
