# NuviloView Privacy / App Store Audit

Audit date: 2026-09-03 (Asia/Tokyo)

Repository: `Suomi121/NuviloView-bot`

Audited source: `origin/main` at `3bd04b6d7cfa69a97cb413f9620aed94d2be3ea7`

Production check: the live `/privacy` response contains the 2026-08-14 policy that is present at the audited commit. The exact Vercel source SHA could not be read from the available deployment API scope, so content parity rather than deployment-metadata equality was verified.
Excluded: open PR #22 (`feat/retention-foundation-v1`, `a5ef28c6...`), other repositories, and synthetic-only test fixtures.

This is an implementation audit, not legal advice. It distinguishes what the service does today from release requirements and planned work.

## 1. Decision gate

The implementation facts needed to correct the public policy are established. The policy can therefore be updated without guessing. Two App Store release questions remain product/operations gaps rather than reasons to retain inaccurate wording:

- there is no in-app account-deletion initiation flow; and
- Google AdSense is loaded globally in Production. The repository does not prove that account-level non-personalized/restricted-data settings are enabled, so App Store tracking must be answered conservatively until the operator verifies those settings.

## 2. Data-flow map

```text
Discord guild event
  -> NuviloChan Bot collection (only guilds/channels the Bot can access)
  -> normalization and local processing
  -> SQLite raw event/state storage on the Bot host
  -> 15-minute local aggregation / Projection v2
  -> checksum change detection
  -> changed aggregate snapshot only
  -> Supabase + Turso
  -> Web Read Router (Supabase primary, Turso fallback)
  -> authenticated, guild-authorized Dashboard display/export

Discord OAuth
  -> identify + guilds scopes
  -> Better Auth
  -> Supabase Auth/control storage
  -> session cookie and managed-guild authorization

History Import
  -> authenticated guild administrator request
  -> cloud control-plane job/cursor metadata
  -> Discord history collection by Bot
  -> SQLite raw message history
  -> the same local aggregation/projection path

Support form
  -> rate-limited Web API
  -> cloud support record
  -> Resend email to the operator

Web page visit
  -> Vercel hosting/request processing
  -> Vercel Web Analytics page-view aggregation
  -> Google AdSense tag and Google advertising processing
```

Failure paths do not change the privacy classification: Supabase read failure can fall back to Turso; Neon is legacy/optional for current analytics but remains reachable by compatibility/control paths. A local copy is still collection and processing even when raw data is not replicated to the cloud.

## 3. Internal data inventory

| Data category | Exact fields / material | Source and trigger | Local storage | Cloud / third party | Purpose | Access / user-facing | Retention and deletion | Public policy / Apple type |
|---|---|---|---|---|---|---|---|---|
| Discord identity | user ID, username/display name, avatar; generated non-deliverable email key | Discord OAuth sign-in | session/browser cookie | Supabase Auth/control; Discord | authentication, profile display, authorization | user; Web backend; authorized operator where necessary | session normally 7 days; account record has no self-service deletion | Account/Discord; Name, User ID |
| OAuth credentials | provider account ID, access token, refresh token, ID token when supplied, token expiry/scope, session token | OAuth callback/refresh | cookie for session | Supabase Auth/control | keep Discord sign-in and guild authorization working | Web backend; restricted operator access | purpose-dependent; no in-app deletion/revocation flow | Account/Discord; User ID |
| Managed guild authorization | user ID; cached guild ID/name/icon/owner/permissions JSON and fetch time | OAuth guilds scope and Dashboard/API use | browser state only where rendered | Supabase control cache; Discord | list manageable guilds and enforce per-guild authorization | signed-in user and Web backend | cache freshness is bounded, but record lifetime is not a public fixed period | Discord/access; Other Data |
| Guild metadata | guild ID/name/icon/owner ID/member count | Bot ready/member/guild events and Discord API | SQLite-derived state and process memory | control/legacy tables and aggregate snapshots | analytics, authorization, status, support | guild managers; Bot; operator where necessary | no universal fixed automatic deletion | Guild data; Other Data |
| Channel metadata | channel ID/name/type, guild ID, Bot readability, updated time | Discord channel inventory and events | raw event payload/state | Supabase control registry; aggregate projection identity; Turso projections | analytics labels, channel access warnings, authorization | guild managers | no universal fixed automatic deletion | Server activity; Other Data |
| Message raw events | stable event ID, guild/channel/message/author IDs, author name, author role IDs, create/update/delete, full content, content checksum, event/revision/source times, reply/reference IDs/type, tombstone state | guild `messageCreate`, update/delete, History Import | SQLite `message_events` and revision log | normal Production analytics path sends no raw content; legacy `discord_message` rows may remain in Neon/control DB | search, history import, analytics aggregation, edit/delete state, reprocessing | Bot; authorized guild managers for search/import; operator only for support/repair | no Production-wide local raw 90-day deletion; delete event tombstones normal current content; import-job deletion exists | Messages; Emails or Text Messages; User ID |
| Attachments/embeds/stickers | no attachment body, embed body, sticker content, image/video/audio file | Discord message may contain them, but current normalizer does not persist their body/metadata | not stored as separate fields | not intentionally sent | none | none | not applicable; URLs typed into message content remain part of text | Exclusion in policy |
| Reaction raw events | event ID, guild/channel/message/user IDs, emoji key, add/remove, recipient ID, reactor bot flag/role IDs, timestamp | reaction add/remove | SQLite raw events/current state | aggregate counts/top emoji/unique reactors only in Supabase/Turso projections; raw security/control history may exist separately | reaction analytics and activity insights | guild managers see aggregates; operator for repair/audit | no universal fixed automatic deletion | Reaction activity; User ID / Other Usage Data |
| Voice raw events | event/session ID, guild/user/channel and previous channel IDs, role IDs, join/move/leave, started/ended times, duration, recovery reason/state | voice state update | SQLite raw events/active sessions | aggregate seconds/minutes/sessions/unique members/peak/top-channel values in projections | voice analytics and recovery | guild managers see aggregates | no universal fixed automatic deletion | Voice connection metadata; User ID / Other Usage Data |
| Voice media | audio, video, screen share content | Discord voice | not collected | not sent | none | none | not applicable | Explicit exclusion |
| Member raw events | guild/user ID, join/leave/update/sync, bot flag, role IDs/hash, joined/left time, current presence, member count | guild member and reconciliation events | SQLite raw/current state | aggregate member and activity snapshots in Supabase/Turso; registries/control rows may remain | member statistics, active-member insights, role filters | guild managers see aggregates | no universal fixed automatic deletion | Member activity; User ID / Other Data |
| Analytics projections | current/daily guild, daily channel/user buckets; counts, durations, active/unique members, trends, goals, insights, timestamps, schema/snapshot version, checksum | fixed-window local compaction | SQLite projection cache/dirty state | Supabase required primary; Turso required replica/fallback; optional legacy Neon compatibility | Dashboard analytics and reliable fallback | authorized guild managers; operator for integrity checks | retained as current/daily snapshots; no fixed public deletion period | Analytics; Product Interaction / Other Usage Data / User ID |
| History Import control | requester/user/guild/channel IDs, range, status, cursor, counts, error code, start/end/update times | administrator starts/pauses/cancels/deletes import | SQLite raw imported messages and local deletion tasks | cloud control metadata | controlled backfill, progress, recovery, deletion | guild managers; Bot worker; operator for support | imported raw follows current indefinite local policy; explicit import deletion removes import-sourced local rows while preserving promoted live rows | History import; User Content / User ID |
| Snipe memory | channel/message ID, deleted content, author ID/name, deleted time, audit-log deleter ID/name | message delete and explicit command | process memory only | command result is posted to Discord; not added to cloud DB | show recent deletions in the channel | members who can see command channel; deletion of result limited by command rules | up to 999,999 items/channel and 90 days; lost on process restart; oldest evicted first | Message/Snipe; Emails or Text Messages |
| Moderation/security audit | guild/channel IDs, actor/target IDs and names, action, reason, count/condition, status, error code/message, severity, timestamps | manual moderation, spam/security decisions | SQLite immutable audit/security event | bounded audit delivery may sync to required cloud providers; Discord alert channel may receive a bounded notice | abuse prevention, accountability, support, incident investigation | guild moderators/admins as designed; restricted operator | purpose-dependent, no fixed period | Security/moderation; User ID / Other Data |
| Spam working state | guild:user key, recent timestamps/counts, cooldown | each message | process memory | audit outcome/alert only; no extra message-body copy for detector | rate-limit protection and automated moderation | Bot and authorized moderators | short rolling window in memory | Security purpose |
| Block lists | blocked guild/user/channel IDs, actor/reason/audit times | authorized operator action | Bot runtime cache where loaded | control database | service protection, legal/safety response | restricted operator; affected service scope | until removed or no longer needed; local raw purge is not comprehensive | Operations; User ID / Other Data |
| Settings/goals/notifications | user/guild IDs, theme/branding/time zone/preferences, goals/progress, notification/alert configuration | authenticated user/admin settings | browser state/cache | Supabase control (legacy Neon-compatible paths may remain) | personalization, analytics goals, notifications | owning user / authorized guild manager | until changed, deleted, or account/guild request is processed | Product Personalization / User ID |
| Runtime/health | Bot/worker/storage/provider status, original heartbeat timestamps, snapshot version/checksum, host/runtime diagnostic metadata internally | periodic Bot/worker heartbeat and health checks | SQLite snapshots/logs | Supabase/Turso runtime snapshots; legacy heartbeat paths may exist | availability monitoring, failover, incident response | public monitor returns only `ok/down`; restricted operator sees detail | rotating logs/config-dependent; snapshots replaced over time | Diagnostics / App Functionality |
| Web session/network | session ID/token, IP address, user agent, expiry; rate-limit hash/bucket/count/time | login and Web/API requests | browser cookie | Supabase session/rate-limit records; Vercel platform logs | authentication, abuse prevention, reliability | Web backend and restricted operator | session normally 7 days; old rate-limit records cleaned after about 7 days; platform logs follow provider policy | User ID / Device information / Diagnostics |
| Web analytics | page, route, referrer, filtered query params, coarse country/region/city, OS/browser/device type, timestamp, daily request hash | Production page load/navigation | browser sends event | Vercel Web Analytics | aggregate site usage | operator aggregate view | Vercel documents daily/24-hour visitor identification behavior; provider retention applies | Product Interaction; generally not linked by Vercel default |
| Advertising | page URL, IP address, cookies/identifiers, ad impression/click/activity, browser/device context; possible Google-account association depending settings | Google AdSense tag loaded by Production root layout | cookies/local storage controlled by Google/browser | Google and eligible advertising partners | ad serving, fraud prevention, measurement, and potentially personalization | Google/partners; operator receives advertising reports | Google/provider controls and policies | Device ID, Product Interaction, Advertising Data; tracking must be answered conservatively |
| Support | signed-in user ID when available, name, reply email, message, created/updated time | optional support form submission | browser form state | cloud support record and Resend email | respond to request, troubleshooting | requester, Web backend, operator/mail provider | necessary support/legal period; no fixed period | Name, Email, Customer Support |
| Translation | selected/input message text and translated result; monthly character total | user invokes translation | Bot memory for at most 5 minutes; monthly aggregate counter | local LibreTranslate at Bot host; no external translation API in audited default path | requested translation and quota control | invoking user; Bot | text discarded after processing window; aggregate retained | Text Messages (real-time processing may be exempt from Apple collection if not retained off-device) |
| Export | authorized Dashboard analytics rendered as CSV/PNG where offered | user export action | downloaded to user's device | data read from authorized Web API/projections | user-requested reporting | requesting guild manager | user controls downloaded copy; source retention as above | Same types as source data |
| Legacy security records | Discord/guild/audit identifiers, historical assessment/action/status and stored configuration evidence | historical, removed feature | not newly collected by current feature | legacy cloud schema/data | forensic history, rollback, legal/accountability | restricted operator | retained while needed; no fixed period | Security/operations disclosure, without publishing internals |

No intentional collection was found for payment/credit data, health/fitness, precise location, address-book contacts, biometric/body/surroundings data, or voice recordings. Free-form Discord messages or support text may contain sensitive facts chosen by users; the service does not intentionally classify those facts as sensitive-category datasets.

## 4. Raw vs. aggregate storage

| Layer | Current Production role | Contains message body? | Contains direct/pseudonymous IDs? |
|---|---|---:|---:|
| SQLite on Bot host | primary raw event and operational store | Yes, for message/history rows | Yes |
| Supabase | Web Auth/control plus primary Projection replica | No in normal Projection payload; support/control records may contain user-entered text | Yes |
| Turso | Projection replica/read fallback | No in normal Projection payload | Yes |
| Neon | legacy/optional compatibility and some remaining control paths | Legacy message/control rows may | Yes |
| Vercel | Web/API hosting, platform logs, Web Analytics | API requests/support processing may pass text; analytics should not intentionally receive message bodies | session/request/analytics context |

The projections are pseudonymous/linked, not anonymous, because user/channel/guild IDs remain in bucket identity or payload. `Raw Cloud Analytics Write = 0` does not mean raw data is not collected locally.

## 5. Storage and processor inventory

| Provider | Purpose | Data sent | Raw / aggregate | Production role | Fallback / optional | Region / retention evidence |
|---|---|---|---|---|---|---|
| Local SQLite | Bot primary storage and queues | Discord raw events, local state, audit, projections | Raw + aggregate | Active | required for Local-First domains | Android/Termux host; no universal raw TTL |
| Discord | identity, guild API, Bot events and command delivery | OAuth identity/guilds; command/result and Bot traffic | Raw at source | Active | required | Discord policy/configuration |
| Supabase | Auth/control and primary Projection read/write | OAuth/session/control rows; aggregate snapshots | control + aggregate | Active | Turso backs Projection reads, not Auth | exact project region not established from repository |
| Turso | independent Projection replica and read fallback | aggregate snapshots | aggregate | Active | fallback for Projection only | exact DB region not established from repository |
| Neon | legacy/compatibility control paths | legacy message/control/audit data as applicable | legacy raw/control | Optional/degraded for analytics; not primary Projection | no automatic Auth fallback from Supabase | exact project region not established; legacy records remain |
| Vercel | Web/API hosting and analytics | requests, IP/UA in platform handling, page-view dimensions | operational/usage | Active | none | provider policy; Web Analytics documents aggregated/non-cross-site identity defaults |
| Resend | support mail delivery | support name/email/message | raw support content | Active when configured | email failure does not change stored request | provider policy |
| Google AdSense | ads and measurement | URL, IP, cookies/identifiers, ad activity/device context | usage/advertising | Script active in Production layout | account/user settings affect personalization | Google policy/settings; repository does not prove non-personalized mode |
| LibreTranslate | requested translation | message text | raw transient text | Local service by audited configuration/default | remote URL could be configured, but current policy/ops require local host | at most 5 minutes in Bot memory; not DB-persisted |

No runtime call path was found for unrelated AI providers, payment processors, health services, or data brokers in this repository.

## 6. Feature classification

| Feature | Class | Production data? | Data categories | Purpose | Disclosure needed? | Reason |
|---|---:|---:|---|---|---:|---|
| Discord sign-in and Dashboard | A | Yes | identity, OAuth, session, guilds | authentication/authorization | Yes | user-facing and linked |
| Bot analytics and Projection v2 | A | Yes | message/reaction/voice/member raw + aggregates | server analytics | Yes | core service |
| History Import | A | Yes | historical messages and job control | backfill analytics/search | Yes | administrator-facing Production feature |
| Message search/export | A | Yes | message text/metadata; aggregate reports | search/reporting | Yes | administrator-facing Production data |
| Snipe/translation/moderation/spam | A | Yes | content, identity, audit, transient text | commands/safety | Yes | user/admin-facing |
| Settings/goals/notifications | A | Yes | user/guild settings and metrics | personalization/alerts | Yes | user-facing |
| Support | A | Yes | contact/support text | assistance | Yes | user-facing |
| Operator monitoring/integrity tools | B | Yes | runtime/projection identifiers and diagnostics | maintenance/incident response | Yes, by purpose/access | internal names and endpoints need not be published |
| Operator block/audit/repair tools | B | Yes | guild/user/channel IDs, audit/reasons | safety/support/data integrity | Yes, by purpose/access | authorized operator can read/change Production scope |
| Guarded server-configuration recovery code | B | Potentially | channel/role/permission/config backups and audit | requested recovery and controlled operations | Yes, by purpose/access if enabled/used | developer-only does not remove privacy impact |
| Archived removed-security records | B | Yes, historical | identity/audit/config evidence | forensic/rollback/legal | Yes, by purpose/access | record remains even though collection stopped |
| Unit tests, isolated DB tests, synthetic canaries | C | No | synthetic fixtures | engineering validation | No | no Production user-data access |
| Retention Foundation PR #22 | Future/not Production | No current effect | proposed retention evidence | future retention controls | Not current policy | open and unmerged |

## 7. Existing policy statement audit

| Policy statement | Actual implementation | Status before update | Required change |
|---|---|---|---|
| Discord OAuth does not request email | scopes are `identify` and `guilds`; generated `@users.invalid` key | SUPPORTED | retain |
| Individual reactions and reactors are not stored | SQLite stores reactor ID, emoji and add/remove; projections store aggregates | FALSE | disclose local raw reaction processing |
| Search/history message content is always deleted after 90 days | legacy cloud cleanup targets 90 days, but current SQLite raw has no Production retention worker | FALSE | remove universal promise and state present retention reality |
| Bot deletion event removes saved message | current local path tombstones/removes normal content, while Snipe keeps a bounded memory copy | PARTIALLY_SUPPORTED | explain exception and identifiers/state |
| Only aggregated reaction/activity data is handled | raw event storage exists locally | FALSE/AMBIGUOUS | distinguish local raw from cloud aggregate |
| Neon is the database provider | Supabase and Turso are active; Neon is legacy/optional | OUTDATED | name current provider roles |
| Vercel Analytics and AdSense operate only on public pages | both are injected from the root Production layout | FALSE | say Web pages, not public pages only |
| Advertising receives only necessary device/view data | AdSense can use cookies and cross-site/account data for personalization/measurement | AMBIGUOUS | describe possible advertising identifier/tracking behavior and controls |
| Operator may use restricted management features | Production-data monitoring/audit/repair paths exist | SUPPORTED but incomplete | clarify purposes and minimum-necessary access without internal names |
| DM/audio/video/screenshare/attachment bodies are not saved | guild-only handlers; no media capture/attachment-body storage found | SUPPORTED | retain |
| Translation is local and text is not DB-persisted | local LibreTranslate path and transient memory design | SUPPORTED for audited Production design | retain; re-audit if URL points off-host |
| Rate-limit hashes are cleaned after about 7 days | implementation has 7-day old-row cleanup | SUPPORTED | retain as non-absolute operational wording |
| Users can request deletion by support | support route exists; comprehensive local deletion is not automated | PARTIALLY_SUPPORTED | state process limitations; do not imply self-service completion |
| Data is not used to train AI models | no AI model runtime path found in this repository | SUPPORTED | retain |

## 8. Privacy gap report

| ID | Severity | Current policy problem | Actual implementation / why incorrect | Proposed fix |
|---|---|---|---|---|
| PP-001 | CRITICAL | says individual reaction content/reactors are not stored | raw SQLite reaction events contain user ID, emoji, target IDs and action | replace with accurate local-raw disclosure |
| PP-002 | CRITICAL | promises search/history message deletion after maximum 90 days | no active Production-wide Local Raw Retention exists | remove promise; disclose no universal fixed local TTL |
| PP-003 | HIGH | identifies Neon but omits Supabase/Turso | Production architecture uses Supabase primary and Turso Projection fallback | describe each provider's present role |
| PP-004 | HIGH | does not explain Local-First raw vs. cloud Projection | raw data is local; linked aggregate snapshots are cloud-synced | add data-flow/storage explanation |
| PP-005 | HIGH | AdSense disclosure does not explain cookie IDs/personalization/measurement | Production root layout loads the Google ad tag; Google documents those uses | add advertising data and control wording |
| PP-006 | MEDIUM | omits message edit/delete/reference and role metadata | current normalizers store these fields | expand categories without table-name disclosure |
| PP-007 | MEDIUM | omits individual voice/member/reaction raw-event retention | SQLite stores them without a universal TTL | expand categories and retention section |
| PP-008 | MEDIUM | operator-access wording does not cover integrity/repair/forensic purpose clearly | Class B tools access Production identifiers/snapshots/audits | clarify minimum-necessary authorized access purpose |
| PP-009 | MEDIUM | deletion request wording can imply a complete supported product flow | local deletion is not comprehensive and no in-app initiation exists | describe current support route honestly; record product gap separately |
| PP-010 | MEDIUM | calls cloud aggregate information effectively anonymous by omission | projections retain Discord/guild/channel/user IDs | state that aggregates are not necessarily anonymous |
| PP-011 | LOW | provider roles and failure/fallback are unclear | Neon is no longer primary analytics path | concise provider-role wording |
| PP-012 | LOW | operational heartbeat/runtime data is omitted | local/cloud runtime snapshots and logs exist | add technical-operation category |

## 9. Product gaps (not papered over by policy)

| ID | Severity | Gap | Release impact / recommendation |
|---|---|---|---|
| PG-001 | CRITICAL | no in-app flow to initiate deletion of the automatically created OAuth account | Apple states account-creating apps must provide in-app initiation. Add an authenticated account-deletion entry point and direct completion/status flow before submission. Support-only email/form flow is generally insufficient. |
| PG-002 | HIGH | no comprehensive deletion workflow spanning Supabase Auth/control, local SQLite raw data, projections, Turso and legacy Neon | define identity/guild scope, legal exceptions, operator verification, provider deletes/tombstones and completion evidence before promising complete deletion |
| PG-003 | HIGH | Google AdSense personalization/restricted-data/consent settings are not represented in the repository | verify account-level configuration and App Store/ATT consequences; if tracking is not intended, enforce non-personalized/restricted behavior and a suitable consent path rather than relying on policy text |
| PG-004 | MEDIUM | Local Raw Retention/Cleanup is unimplemented in Production | finish and separately approve retention only after the current Foundation review; until then publish no fixed 90-day promise |
| PG-005 | MEDIUM | no repository evidence of a user privacy choices/account-data management URL | add a direct privacy choices/deletion status page if the App Store record will use that optional URL |
| PG-006 | MEDIUM | exact live Vercel deployment SHA could not be read with the available deployment API scope | record and verify source SHA in the release checklist; live policy content matched audited main |
| PG-007 | LOW | policy localization is Japanese-only while parts of the Dashboard support English | consider an English policy URL/text before listing English App Store localization |

## 10. App Store Privacy mapping

Apple's answers apply at the app level, must include integrated third parties, and should be inclusive across platforms. The table is a conservative mapping for the current service. `Tracking` remains a launch decision where noted.

| Apple data type | NuviloView data | Collected? | Linked to user? | Used for tracking? | Purpose | Notes |
|---|---|---:|---:|---:|---|---|
| Contact Info — Name | Discord display/username; optional support name | Yes | Yes | No by NuviloView | App Functionality, Customer Support, Analytics | ongoing Discord identity must be disclosed |
| Contact Info — Email Address | support reply email; generated auth key is not a real address | Yes (support only) | Yes | No | Customer Support | optional-disclosure criteria may apply, but conservative disclosure is safer |
| User Content — Emails or Text Messages | Discord guild message content, imported history, Snipe content, translation input | Yes | Yes | No by NuviloView | App Functionality, Analytics | raw stored locally; no raw cloud analytics replication |
| User Content — Customer Support | support message/name/email | Yes | Yes when signed in/provided | No | App Functionality | sent to Resend/operator |
| User Content — Other User Content | guild/channel names, goals, moderation reasons/settings | Yes | Yes | No | App Functionality, Product Personalization, Analytics | some values are server-level rather than a natural person |
| Search History | in-app message search query | Review required | Yes when request/session is linked | No | App Functionality | app DB does not separately store query; confirm Vercel request-log/query retention before final answer |
| Identifiers — User ID | Discord/user/session/guild actor IDs | Yes | Yes | No by NuviloView | App Functionality, Analytics, Security | projections remain linkable |
| Identifiers — Device ID | Google advertising cookie/browser identifier | Yes via Google tag | Potentially | **Yes unless verified restricted/non-personalized configuration changes the result** | Third-Party Advertising, measurement/security | conservative answer based on loaded AdSense tag |
| Usage Data — Product Interaction | page views/routes/referrer/device/browser/coarse region; Discord activity events | Yes | NuviloView projections: Yes; Vercel default analytics: generally No | Google portion may track | Analytics, App Functionality, Third-Party Advertising | split by processor in App Store answers if available |
| Usage Data — Advertising Data | impressions/clicks/ad activity | Yes via Google tag | Potentially | **Yes, conservatively** | Third-Party Advertising | verify AdSense account settings before submission |
| Usage Data — Other Usage Data | message/reaction/voice/member counts and event metadata | Yes | Yes | No by NuviloView | Analytics, App Functionality | raw local plus linked aggregate cloud snapshots |
| Diagnostics — Other Diagnostic Data | heartbeat, provider/storage state, error/audit logs | Yes | Sometimes (guild/user/actor IDs in audits) | No | App Functionality, Security | public monitor reveals only status |
| Location — Coarse Location | Vercel derives country/region/city; Google uses IP for general location | Yes via processors | Vercel aggregate default: No; Google potentially | Google portion may track | Analytics, Third-Party Advertising | no GPS/precise location collection |
| Other Data | guild/channel/role metadata and server-level metrics | Yes | Linked/pseudonymous | No by NuviloView | App Functionality, Analytics | not anonymous while IDs remain |

Not collected intentionally: phone/physical address, health/fitness, payment/credit/financial information, precise location, contacts/address book, photos/videos, audio recordings, sensitive-info category fields, body/surroundings data, purchases.

### Tracking determination

NuviloView's Bot/analytics code does not sell data, use data brokers, or perform cross-service tracking. However, the Production root layout loads Google AdSense on every page. Google documents that AdSense can use cookie IDs and information from other sites for targeted advertising and advertising measurement. Until the publisher account and consent/restricted-data behavior are verified and enforced, App Store Connect should not claim `Data Used to Track You = No`.

## 11. Access and authorization findings

- Dashboard and analytics APIs revalidate the signed-in Discord account and require ownership or Manage Guild permission for the requested guild.
- Turso fallback occurs only after authorization; it is not an authentication provider and does not bypass guild checks.
- Developer/operator access is tied to configured allowed Discord IDs and server-side checks rather than a client-supplied role.
- Internal monitoring and repair surfaces can access Production identifiers/metrics/audits. Their names need not be public, but their maintenance, safety, support and integrity purposes must be disclosed.
- No evidence of a deliberate cross-guild public data read was found in this privacy-focused review. This is not a substitute for a standalone penetration test.

## 12. Retention and deletion findings

- The current main branch has no active Local Raw Retention migration or cleanup worker. PR #22 is unmerged and cannot support a present-tense policy promise.
- SQLite message/reaction/voice/member raw data and security audit can remain without a universal fixed TTL.
- The legacy cloud message cleanup targets roughly 90 days only when that legacy path/database is available; it is not an end-to-end guarantee.
- A Discord delete event tombstones current normal message content, but Snipe deliberately retains a bounded memory copy for up to 90 days.
- History Import supports deletion of import-sourced local rows through its worker contract; it is not the same as account-wide or guild-wide deletion.
- Leaving a guild stops future collection but does not automatically erase all existing local/cloud/legacy records.

## 13. Apple official sources checked

Checked on 2026-09-03:

- [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy): privacy policy URL and App Store Connect data-practice answers are required; responses must cover third-party partners and remain current.
- [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/): collection, linked-data and tracking definitions plus data-type/purpose taxonomy.
- [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/): account-creating apps must provide an in-app way to initiate full account deletion; ordinary apps should not require email/support-only flows.
- [Vercel Web Analytics privacy and compliance](https://vercel.com/docs/analytics/privacy-policy): default aggregate analytics fields and non-cross-site visitor identification behavior.
- [How AdSense uses cookies](https://support.google.com/adsense/answer/7549925): cookie identifiers, personalization, reporting and cookie timing.
- [How Google uses information from sites or apps that use its services](https://policies.google.com/technologies/partner-sites): URL, IP, cookies, ad measurement and personalization uses.

## 14. Review verdict

The policy corrections are evidence-backed and suitable for a pull request. App Store submission itself is **NO-GO** until PG-001 (in-app account deletion) and PG-003 (AdSense tracking/consent determination) are resolved, and PG-002 has a defined deletion execution process. The code/policy PR must not be merged without explicit approval.
