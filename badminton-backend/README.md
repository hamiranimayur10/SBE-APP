# SBE Light Vs Dark Side Tournament — Vercel + Turso

The app is served from `public/index.html`; Vercel runs the Express API in `badminton-backend/server.js`. Tournament state, player check-ins, and player profiles are stored in **Turso (libSQL), a hosted SQLite-compatible database**. Vercel's function filesystem is temporary, so do not use a local `.db` file for persistent production data.

## App pages
The shared application code lives in `public/app.js` and is loaded by the dashboard and the other static page entries. Each page has a direct URL, so browser refresh and back/forward navigation work without duplicating tournament state:

| Page | URL |
| --- | --- |
| Dashboard | `/` |
| Tournaments | `/tournaments.html` |
| Tournament setup | `/setup.html` |
| Qualifier rounds | `/qualifier-round-1.html`, `/qualifier-round-2.html` |
| Semi-finals and finals | `/semifinals.html`, `/finals.html` |
| Bracket | `/bracket.html` |
| Players and performance | `/players.html` |
| Check-in | `/check-in.html` |
| Rules and format | `/rules.html` |

Page navigation keeps the selected tournament and configured API URL in the query string. The check-in QR code links directly to the check-in page. Logged-in players can check in only their own roster entry from **Attendance** or their profile in **Players**; admins manage attendance on the check-in page.

## Deploy to Vercel
1. Import this GitHub repository into Vercel with the repository root as the project root.
2. Create a Turso database:
   ```bash
   turso db create badminton-tournament
   turso db show badminton-tournament --url
   ```
3. Add `SBE_TURSO_DATABASE_URL`, `SBE_TURSO_AUTH_TOKEN`, and a strong random `ADMIN_PASSWORD` (16–256 characters) to the Vercel project's **Production** environment variables, then deploy. The API also accepts the legacy `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` names. The API creates its tables automatically on first request.
4. Open the Vercel URL. Cloud Sync uses the app's same-origin `/api` endpoints by default; no backend URL is needed.

Admins sign in with `ADMIN_PASSWORD`, not the old four-digit PIN or sync key. Each browser receives a separate HTTP-only session cookie valid for 30 days; signing out revokes that browser's session. Rotating `ADMIN_PASSWORD` and redeploying invalidates existing sessions. This is a shared admin password, not separate named accounts. Generate a long random value and share it only with trusted admins. Login attempts are limited to ten per 15 minutes across the deployment. Set the password before deploying this version; without it, admin sign-in is unavailable. Guests and players can still view the app.

Existing API clients may continue using `ADMIN_SYNC_KEY` via `x-sync-key`; remove that environment variable after migrating all legacy clients to disable that access. The old key is not needed in Cloud Sync for same-origin admin sessions. Cross-origin custom backends and local-only mode retain the legacy PIN/key behavior; sessions require the app and API to share an origin.

## Run locally
1. From the repository root, install and start:
   ```bash
   npm install
   npm start
   ```
Without Turso environment variables, local development uses `badminton-backend/local.db`. Copy `badminton-backend/.env.example` to `badminton-backend/.env` and set a strong `ADMIN_PASSWORD`. To use Turso locally, also set `SBE_TURSO_DATABASE_URL` and `SBE_TURSO_AUTH_TOKEN` (or the legacy `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`). The example file contains placeholders only. The app and API are available at `http://localhost:3001`. A static preview on port 8080 connects to port 3001 using the legacy PIN and `ADMIN_SYNC_KEY`; open port 3001 directly to use admin sessions.

## Player accounts and profiles
Admins can create a player-specific one-use invitation or a reusable invitation in the **Players** section. Share the generated link manually; the app does not send email or SMS. Email invitations require registration with the matching email address. Generic invitations can claim an unclaimed roster player or create a new profile.

After player sign-in, the app opens the tournament library with current/upcoming and past events, matching the guest view. The navigation offers **My Player Card** for the player's own profile, account, and check-in controls.

Guests and players can use **Match Center** to view fixtures, scores, standings, and brackets, including the Round 1 group filters. Score entry, schedule changes, and round advancement are available only to admins.

Guest and unauthenticated QR check-in views are read-only. Admins can manage attendance; a signed-in player can check in only their own roster entry from Attendance or My Player Card, once, and only before the tournament is completed.

With the backend connected, admin and player check-ins are saved immediately in a database transaction and confirmed only after the save succeeds. Admin check-in removal is also saved immediately. If a request cannot be confirmed, refresh attendance before retrying. Without a backend, admin attendance remains browser-local.

Players register with an email and a password of at least 12 characters using an administrator invitation; open self-registration is disabled. Sessions use an HTTP-only cookie and are restored on return. Players can change their own password after entering the current password and may delete their login while signed in. Deleting a login preserves the player profile and tournament history. Admins can edit player names and reset account passwords; resets issue a one-time temporary password, invalidate existing sessions, and require the player to choose a new password before continuing. Admins can also remove a player's login without deleting the profile or match history. A player can view every tournament section and check in only their own roster entry from **Attendance** or their profile in **Players**; they cannot change tournament data, check in another player, or modify other player profiles. They can edit only their own photo, name, nickname, gender, club/academy, skill, location, emergency contact, playing hand, preferred events, and email. Profile photos can be uploaded from a device; supported JPEG, PNG, and WebP files are resized and stored in the profile database. Each profile field can be hidden from public player cards. Historical tournament results may continue to show names previously recorded there.

Players and admins can save an optional whole-number profile skill from 1 to 10. When a player is added to a tournament, that skill is copied to the tournament roster; an unset skill defaults to 5. Admins can override the tournament skill without changing the profile. Later profile changes do not alter existing tournament skills or overrides. The profile skill can be hidden on public player cards, but the tournament roster's skill remains visible to tournament viewers.

## Player profiles and performance
The **Players** section recalculates match records, form, ranking points and finishes, head-to-head results, doubles partnerships, badges, and heuristic forecasts from completed scores in saved tournaments. Player profiles also list every completed match score (including each game in a final). This keeps tournament match records as the source of truth instead of storing duplicate career totals. Every player has a unique six-digit player code for display and lookup. Profiles remain linked to roster and score records by stable internal UUIDs, including historical aliases. Admins can add or edit shared player-card details (photo, age, club, and ranking). Admins can also delete a profile and its login; historical scores remain, but the deleted player's name and profile links are anonymized so opponents' stats are preserved. Photos are stored with profile data in SQLite/Turso; uploaded files are compressed to fit the 675 KB limit. Profiles and tournament history use `/api/players`, `/api/players/:name`, and `/api/tournament-history`; local development stores these in the same SQLite database. Forecasts are estimates from recorded results, not official rankings or betting advice. Triple Crown badges remain unavailable until tournaments track three event categories.

The cloud-backed player directory reads profiles and tournament history together from one database snapshot, refreshes while the page is open, and does not merge in stale browser-only players. Offline/local-only mode still uses local data. If a cloud refresh fails, the page reports that previously loaded results may be stale. Profile edits require the revision displayed when editing and reject concurrent changes rather than overwriting them.

Admins can use **Delete Players** to select multiple or all saved profiles, then confirm the deletion. All selected profiles, accounts, invitations, check-ins, and tournament-history anonymizations are committed in one transaction; if a profile changed or any deletion fails, none are deleted. Individual deletion uses the same safeguards. Unsynced local tournament changes must be resolved first. Scores remain intact, with deleted identities anonymized.

## Excel roster import and player IDs
Admins can import `.xlsx`, `.xls`, or `.csv` rosters from **Setup → Players & Groups** or **Check-In**. The wizard selects a worksheet, maps its headings to profile fields, and previews detected matches before replacing the current event roster. Existing players are matched by unique player ID, email, full name, nickname, or known alias across saved profiles and tournament rosters; duplicate rows are skipped, and ambiguous matches block import. Missing profiles are created, while existing profile details are preserved and only blank fields are filled.

Every player profile has a unique six-digit code shown on player cards and used for player lookup. The stable UUID remains internal to preserve roster and match links. Existing database profiles are assigned codes during schema migration, and profiles are also created for legacy tournament-roster players. Imports can match an existing player by six-digit code or a legacy UUID. `/api/player-import/directory` and `/api/player-import` require admin authorization; the spreadsheet is parsed in the browser and only the mapped player records are sent to the app.

## Tournament library and rules
Tournament setup uses a five-step flow for event details, format and scoring, players and groups, ranking rules, and a final review. Changes save as the organizer moves through the steps. Round 2 ranks all Round 1 players by configured Win Points and tie-breakers, then places consecutive ranks into the admin-selected groups; each group must have at least eight players, and its top eight advance to that group's semi-finals. Admins can choose a best-of-three or single-game final independently for every Round 2 group. Group schedules assign two non-overlapping matches to separate courts in each round when possible. Visible match and player-score views refresh from the backend every two seconds. In **Players & Groups**, admins search a card-based profile picker by name, six-digit code, or club, or create a new profile first; arbitrary unlinked names cannot be added through the manual-add control. The selected profile UUID is saved internally with the tournament, and the score history is recalculated from completed match results. Admin profile creation and edits require admin authorization when using the backend. Admins can also drag a player by the handle into another group; the move menu remains available as a touch-friendly alternative. Moving a group leader assigns the next available player as the old group's leader and makes the moved player leader if the destination has none. Import or replace the roster from **Setup → Players & Groups**; the Check-In screen also keeps its import shortcut. Navigation groups setup and saved tournaments, match rounds and brackets, player performance and attendance, plus event rules. The **Tournaments** page separates current/upcoming events from completed or past events; opening an event loads its schedule, standings, and results. Organizers can add event-specific rule notes under **Tournament → Setup**. Players and guests can read the published notes alongside the tournament's configured scoring, progression, and ranking rules.

New and reset tournaments start with empty groups. Admins add existing profiles, create profiles, or import a roster in **Players & Groups** before generating a schedule. The players-per-group setting is a target and does not add or remove players; the rostered-player count reflects actual entries. Reset removes the tournament roster and attendance but retains shared player profiles. Existing saved tournaments are not changed.

In **Setup → Format & Scoring**, admins can choose match counts independently for Round 1 and Round 2. Newly generated qualifying schedules are doubles, with four distinct players per match and no repeated partnerships within the same group stage. Every player receives exactly the configured count; each group needs at least four players, the match count must be less than the group size, and group size multiplied by matches per player must be divisible by four. Opponents may repeat, and partnerships may recur in a different stage. A player may appear in only one group per round. Both players on a side receive its win or loss, points for and against, and ranking points. Older tournaments without a separate Round 2 count use their Round 1 count. Existing schedules and scores are not automatically changed.

The Round 1 page includes an overall table combining all groups, ordered by WP first and then the configured tie-breakers. Round 2 assignment still uses the configured ranking order, which can differ if WP is not its first metric. Standings and individual matches are collapsed by default; each group's matches can be expanded or collapsed individually or all at once. Matches are numbered within each group in scheduled order; matches on parallel courts remain grouped together. On the Round 2 page, each completed group's qualifier panel lists its top eight using that group's configured ranking order, as used for the semi-final draw; ties are flagged for the officiating table.

Starting the tournament generates the Round 1 schedule. Once all scores for a stage are recorded, an admin uses **Advance** to generate Round 2, the semi-finals, and then the finals. After all matches have been completed, the admin uses **Mark Tournament Done** on the Finals page to move the event to Past Tournaments and close player check-in. Saving the final scores does not mark the tournament done automatically. Changing an earlier score after a later schedule exists requires confirmation and clears affected later schedules and scores; the admin can then advance again and mark the tournament done again. Round 1 changes affect all later groups, while Round 2 or semi-final changes leave other groups' later results intact.

Admins can enter scores for different matches concurrently. Each score is applied atomically to the latest tournament state; conflicting edits to the same match are rejected rather than overwritten. If a correction would clear later schedules, confirmation applies only to the tournament revision shown to the admin. When a conflict occurs, note any unsaved entries, use **Cloud Sync → Pull from DB**, and review the current scores before retrying. Pulling replaces local tournament changes. Other tournament changes, such as advancing or editing setup, are also rejected if their snapshot is stale. Local-only mode continues to save scores locally.

The tournament API returns a content revision with `GET /api/tournaments/:id`. Full-state `PUT` requests must send that revision in `x-tournament-revision`, or `new` when creating a tournament; stale writes return HTTP 409. Admin-only `PATCH /api/tournaments/:id/matches/:matchId/score` accepts a `listKey`, the match's `expectedMatch`, and either `s1`/`s2` or final `games`. Corrections that clear later schedules also require the confirmed revision as `confirmedRevision`. The endpoint validates scores and returns the updated state and revision.

For semi-finals with eight qualifiers in a group, the top four seeds are each randomly paired with a distinct player from the bottom four to form doubles teams. The resulting draw is saved with the tournament.

The dashboard shows the active tournament phase, current player and match counts, per-round completion, configured Round 2 groups, scoring settings, and each group's final format. Each progress row links to its Match Center round. It refreshes when settings or match scores are synced.

New tournaments receive a unique ID, shown on their tournament card. A tournament remains open until it is completed, closed, or deleted, even if its scheduled date has passed. Before creating another tournament, admins must close or delete every open event. Closing an incomplete event preserves its scores and moves it to Past Tournaments; deletion permanently removes its results, check-ins, and tournament-derived player history and statistics. Shared player profiles are retained. Older tournaments keep their existing IDs, and previously closed events may use the same name as a new event.

The backend enforces the one-open-tournament rule atomically when a tournament is created or an archived tournament is reopened, including when score corrections would reopen it. Existing databases with multiple open events are not changed automatically; each open event must be closed or deleted before a new one can be created.
