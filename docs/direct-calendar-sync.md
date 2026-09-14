# Direct Google and Microsoft calendar sync

Microsoft setup is deferred at the user's request. The connection screen currently offers Google only. Microsoft is disabled by default, including OAuth and background jobs, unless explicitly enabled with `CALENDAR_MICROSOFT_ENABLED=1`; do not enable it until setup is resumed and acceptance is complete. Azure onboarding reached the profile form only; no tenant, app registration, subscription, or credentials were created by the agent.

Status: implemented locally behind a disabled server capability; production activation and live provider acceptance are pending. Do not remove the competitor gap or claim launch until the acceptance record below is complete.

## Scope and architecture

All signed-in Nest users can connect multiple accounts once configured. There is no tier check. Calendar OAuth is separate from Nest login and Canvas consent. `/calendar/connections` owns authorization; the extension only opens that page and fetches verified connection state. Google and Microsoft credentials never enter extension storage or messages.

Migration `024_external_calendar_sync.sql` adds user-scoped provider connections, selections, cache, mappings, operation jobs, conflicts and single-use OAuth state. It adds timezone/location columns and transactional native-event wake-up triggers. Existing Canvas tables retain their authorization rules.

The scheduler scans every minute, uses database leases and four bounded workers, and schedules successful connections 180 seconds later. Each provider client has a 100-second request budget, bounded pagination, timeout and backoff. Failed reads never commit cursors or infer deletions. Each active connection follows a daily rolling window of 30 days ago through 366 days ahead. The five-minute target requires sufficient worker capacity and normal provider availability; monitor oldest sync age and queue depth before widening access.

Google uses incremental tokens and deterministic create IDs. Microsoft uses primary-calendar delta, complete secondary-calendar views, immutable IDs and transaction IDs. Export calendars carry ownership metadata and stored IDs. Interrupted calendar creation requires explicit recovery of a calendar with matching metadata, rather than retrying creation by name.

Personal events merge against baselines, with time fields grouped. Overlapping edits and delete-versus-edit conflicts pause that event. Academic sources remain authoritative; remote deletion suppresses a mapping. Imported events stay in their original account/calendar. Mapped exports are excluded from imported projection to prevent duplicate display. Newly created editable events inside the managed calendar become Nest personal events.

Guest meetings, online/special events and series masters are not edited by APStudy. Recurring occurrences keep their provider occurrence identity. Patches include only changed managed fields so unrelated provider data is preserved. Public shares and ICS continue using existing source projectors; provider caches are not added to those paths.

Disconnect immediately fences further sync requests. An already-issued HTTP request can finish; its worker then completes purge. Retain exports is the default. Cleanup touches only mapped exports and stops for provider review if an event has become a meeting. Minimal mapping identity remains for reconnect; content baselines, imported content and credentials are purged. Reconnect without a baseline asks for resolution when personal versions differ.

## Operator configuration

Set these only in the server secret environment; never commit values:

- `CALENDAR_SYNC_ENABLED=0` initially; exact `1` enables configured providers.
- `CALENDAR_GOOGLE_CLIENT_ID` and `CALENDAR_GOOGLE_CLIENT_SECRET`.
- `CALENDAR_MICROSOFT_CLIENT_ID` and `CALENDAR_MICROSOFT_CLIENT_SECRET`.
- `CALENDAR_TOKEN_ACTIVE_KEY=v1`.
- `CALENDAR_TOKEN_KEYS` is a JSON object mapping key versions to Fernet keys. Generate a dedicated key using `cryptography.fernet.Fernet.generate_key()` directly into protected secret storage. Preserve old versions during rotation until encrypted records have been rewritten.
- `CALENDAR_OAUTH_BASE_URL=https://nest.apstudy.org` (default).
- Preserve the existing `CALENDAR_ICS_UID_SECRET`, used to identify saved-course occurrences, and all existing Canvas rollout/consent configuration.

Callbacks to register without changing existing sign-in callbacks:

- `https://nest.apstudy.org/oauth/calendar/google/callback`
- `https://nest.apstudy.org/oauth/calendar/microsoft/callback`

Google requests `openid email`, `calendar.calendarlist.readonly`, `calendar.events`, and `calendar.app.created`. Enable Calendar API, review the OAuth consent screen, add test users as appropriate, and complete sensitive-scope verification before public activation. Existing registration observed: project `apstudy-435018`, web client named `nest.apstudy`; production currently has legacy Google login credentials but no dedicated calendar settings. Ownership and scope verification remain a release requirement.

Microsoft requests delegated `openid profile email offline_access User.Read Calendars.ReadWrite Calendars.ReadWrite.Shared`. Use a web application supporting personal accounts and accounts in any organizational directory, with the common v2 endpoint. Confirm organization consent policies, publisher verification and mailbox/API availability. No Microsoft registration credentials were present in the inspected local/production environment; tenant/application details are still required.

Provider references: [Google scopes](https://developers.google.com/workspace/calendar/api/auth), [Google incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Microsoft delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0), [Microsoft extended properties](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-post-singlevalueextendedproperties?view=graph-rest-1.0). Export-calendar UX inspiration: [BetterCampus](https://help.bettercampus.com/sync-your-calendar-s15ko).

## Release procedure

1. Preserve unrelated working changes. Run `npm run build`, `npm run build:calendar-extension`, `npm test` and the relevant browser checks. Transfer the generated `static/dist/calendar-extension` files to APStudyCanvas's `js/content/calendar-extension`, then run extension tests/static checks and `npm run build:firefox`.
2. Keep calendar capabilities disabled. Review the feature-only commit, push through Nest's existing CI-backed deployment workflow, and require a clean production checkout. Back up SQLite with the existing backup script before startup applies the additive migration. Keep the prior application revision and database snapshot.
3. Install `deploy/nginx-calendar-oauth.snippet.conf` in the HTTPS server and run `nginx -t` before reload. Configure Gunicorn access logging to omit query strings (use `%U`, never `%r` or `%q`), and confirm upstream/CDN/error logs do not record callback queries. The snippet is prepared, not installed. Do not disable unrelated security logging.
4. Install protected keys/client settings, confirm callback/consent configuration and restart with capabilities still disabled. Then enable only in a controlled validation environment for authorized test accounts. The current switch is global; do not enable production for all users before controlled acceptance.
5. For each provider, use disposable test events to exercise the matrix below. Complete interactive consent with the account owner. After verified acceptance, enable production access and distribute Chromium/Firefox builds. Browser-store publishing is excluded.
6. Inspect `python scripts/calendar_sync_status.py /path/to/calendar.sqlite3` for aggregate age, job states, conflicts and reconnect failures. Alert if oldest active sync exceeds five minutes under normal availability. Review provider throttling and capacity before scaling.

Rollback sets `CALENDAR_SYNC_ENABLED=0` and restarts Nest; it disables jobs/capabilities while preserving mappings and making no external deletions. Do not roll back by dropping tables or deleting provider calendars.

## Acceptance record

Local automated checks cover OAuth state ownership/replay, credential encryption, user isolation, safe transport, CSRF, idempotent CRUD, disjoint/conflicting edits, paging failures, expired Google cursors, secondary Graph reads, meeting edit refusal, field preservation, export suppression/restoration, adoption deduplication and disconnect recovery. Existing Canvas/share/ICS regressions remain required.

The connection browser fixture verifies light/dark desktop/narrow layouts, keyboard connection controls, explicit selections, revisioned conflict review, and retain-by-default disconnect. It uses synthetic data and is not live-provider validation.

Still pending for both providers: real account consent; personal and organization accounts; multiple accounts; refresh and revocation; shared/read-only calendars; individual recurring exceptions; DST/all-day round trips; calendar deletion; crash/timeout recovery; reconnect and cleanup failures; closed-browser background timing; production smoke checks and monitoring. Also complete end-to-end Planner/overlay editing against a live connector. No provider connector is represented as launched.

Once both integrations pass launch acceptance, remove section 5 and all related matrix/sequence/summary/footnote references from APStudyCanvas's competitor analysis, add the completed capability to its baseline and renumber remaining gaps. Preserve task-linked work sessions and course-profile gaps.
