# Health Score v2 — 8 Guild calibration review

Date: 2026-08-21 (JST)

Release channel: Preview / Shadow

Decision: keep Preview / Shadow; do not promote to the formal production score yet.

## Scope and privacy

- Eight connected, non-blocked Guilds with the earliest available analytics signal were reviewed.
- The review period was the latest 30-day window in JST.
- The calibration query was read-only. It did not update the database or runtime flags.
- The generated calibration artifact uses anonymous labels (`Guild-01` through `Guild-08`). It contains no Guild ID, Guild name, user ID, or message content.
- Existing weights were evaluated but were not changed automatically.

## Result

| Measure | Before gate | After gate |
|---|---:|---:|
| Guilds eligible for a formal score | 4 / 8 | 3 / 8 |
| Guilds remaining provisional or unavailable | 4 / 8 | 5 / 8 |
| `discord_sync` join events excluded from Retention/Growth | 0 | 52 |
| Invalid Voice sessions in the reviewed window | — | 0 |

The quality gate correctly removed one formal score that depended on unverified sync-only membership data. The remaining provisional scores were `58, 59, 50, 59, 62, 0, 0, 49`; variance was `609.4`. This sample is too small and too incomplete to justify changing the current `25/25/20/15/15` weights.

## Category quality

Across the five scored categories for eight Guilds (40 category observations):

- Available: 15
- Low confidence: 12
- Unavailable: 13
- Missing/unusable by category: Engagement 0, Retention 5, Distribution 5, Voice 5, Growth 3

Reaction is an Engagement input rather than a standalone weighted category. Six Guilds had reaction data, but all six were still `Immature` (6–12 observation days); two had no reaction observations. Immature Reaction is therefore represented as `null` and is not treated as a zero score.

## Data-quality decisions

### Retention and Growth

- Only live membership events (`gateway` or `discord_live`) contribute to Retention and Growth.
- `discord_sync`, historical import, and unknown sources remain visible as evidence but do not affect the score.
- A sync-only cohort blocks formal availability with `retention_unverified_sources_only`.
- Small live cohorts remain usable only with `LowConfidence`; no live cohort yields `Unavailable`.

### Voice

- Open sessions older than 24 hours, sessions longer than 24 hours, future or negative durations, duplicates, and overlapping sessions are excluded.
- The reviewed eight-Guild window contained 691 valid Voice sessions and no detected invalid sessions.
- Five Guilds still lacked a sufficient Voice sample, so absence is not converted into a zero.

### Reaction

- No collection start time produces `Unavailable`.
- Fewer than 14 observation days produces `Immature` and is excluded from Engagement.
- Fewer than 30 days or a small event sample produces `LowConfidence`.
- Reaction maturity must improve before it can be relied on for formal calibration.

## Correlation checks

- Provisional score vs. member count: `0.378`
- Provisional score vs. message activity: `0.304`

These weak-to-moderate relationships do not show that the score is simply a size ranking, but eight Guilds are not enough to validate bias or recalibrate weights.

## Promotion criteria

Health v2 should remain Preview / Shadow until all of the following are met:

1. Reaction collection is mature for a representative majority of Guilds (at least 30 observed days).
2. Retention has enough live join cohorts; sync-only Guilds remain excluded.
3. Voice anomaly monitoring has run long enough to demonstrate stable exclusion behavior.
4. At least one additional calibration window confirms score stability and category variance.
5. The Preview UI clearly distinguishes formal, provisional, low-confidence, immature, and unavailable values.

## Reproduction

Run `npm run health:calibrate`. The script writes an ignored JSON artifact below `output/release-readiness/health-v2/`. It performs SELECT queries only and never writes Guild identifiers or message content to the artifact.
