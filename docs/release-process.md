# Release process

NuviloView uses pull-request releases from a feature branch. Direct pushes to `main`, force pushes, PR merges, tags, GitHub Releases, production deployments, and production migrations are separate approval gates.

## Versioning

Use semantic versioning. Prepare an `-rc.N` candidate when migrations, authentication, runtime ownership, security controls, or backup behavior changes. The current package version remains `0.1.0`; this readiness branch proposes `0.2.0-rc.1` only after the blocking conditions in the release notes are closed.

## Candidate checklist

1. Update `CHANGELOG.md` and release notes with flags, migrations, known risks, and rollback.
2. Run migration manifest validation and static drift checks.
3. Run token scan, syntax check, lint, typecheck, tests, dependency audit, and production build.
4. Review the live drift report read-only; do not apply migrations from CI.
5. Confirm backup restore verification and external monitoring delivery.
6. Confirm dangerous flags remain disabled unless separately approved.
7. Open a PR from the release branch and require CI/review. Merge, tag, release, migration, and deploy are distinct operator actions.

## Rollback

Application rollback uses the previous known-good immutable deployment or commit. Keep additive DB objects in place unless an independently reviewed data-safe remediation says otherwise. Disable newly introduced feature flags first. Preserve audit records and migration journal entries.
