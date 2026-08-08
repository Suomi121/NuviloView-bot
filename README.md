# NuviloView:OEM

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

Because `.env.local` contains credentials, protect both backup HDDs with
BitLocker and restrict physical access.
