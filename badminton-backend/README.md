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

Page navigation keeps the selected tournament and configured API URL in the query string. The check-in QR code links directly to the check-in page. Logged-in players can check in only their own roster entry from their profile in **Players**; admin-operated check-in remains on the check-in page.

## Deploy to Vercel
1. Import this GitHub repository into Vercel with the repository root as the project root.
2. Create a Turso database:
   ```bash
   turso db create badminton-tournament
   turso db show badminton-tournament --url
   ```
3. Add `SBE_TURSO_DATABASE_URL`, `SBE_TURSO_AUTH_TOKEN`, and a strong random `ADMIN_SYNC_KEY` to the Vercel project's **Production** environment variables, then deploy. The API also accepts the legacy `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` names. The API creates its tables automatically on first request. Enter the same admin key in the app's Cloud Sync settings. Player invitation management is disabled until this key is configured.
4. Open the Vercel URL. Cloud Sync uses the app's same-origin `/api` endpoints by default; no backend URL is needed.

## Run locally
1. From the repository root, install and start:
   ```bash
   npm install
   npm start
   ```
Without Turso environment variables, local development uses `badminton-backend/local.db`. To use Turso locally instead, copy `badminton-backend/.env.example` to `badminton-backend/.env` and set `SBE_TURSO_DATABASE_URL` and `SBE_TURSO_AUTH_TOKEN` (or the legacy `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`). Set `ADMIN_SYNC_KEY` in that backend `.env` file and enter the exact same value in the app's Cloud Sync settings; the example file contains placeholders only. The app and API are available at `http://localhost:3001`. If using a local static preview on port 8080, the app routes API requests to port 3001.

## Player accounts and profiles
Admins can create a player-specific one-use invitation or a reusable invitation in the **Players** section. Share the generated link manually; the app does not send email or SMS. Email invitations require registration with the matching email address. Generic invitations can claim an unclaimed roster player or create a new profile.

Players register with an email and a password of at least 12 characters using an administrator invitation; open self-registration is disabled. Sessions use an HTTP-only cookie and are restored on return. Players can change their own password after entering the current password and may delete their login while signed in. Deleting a login preserves the player profile and tournament history. Admins can edit player names and reset account passwords; resets issue a one-time temporary password, invalidate existing sessions, and require the player to choose a new password before continuing. Admins can also remove a player's login without deleting the profile or match history. A player can view every tournament section and check in only their own roster entry from their profile in **Players**; they cannot change tournament data, check in another player, or modify other player profiles. They can edit only their own photo, name, nickname, gender, club/academy, location, emergency contact, playing hand, preferred events, and email. Profile photos can be uploaded from a device; supported JPEG, PNG, and WebP files are resized and stored in the profile database. Each profile field can be hidden from public player cards. Historical tournament results may continue to show names previously recorded there.

## Player profiles and performance
The **Players** section recalculates match records, form, ranking points and finishes, head-to-head results, doubles partnerships, badges, and heuristic forecasts from completed scores in saved tournaments. Player profiles also list every completed match score (including each game in a final). This keeps tournament match records as the source of truth instead of storing duplicate career totals. Every player has a unique six-digit player code for display and lookup. Profiles remain linked to roster and score records by stable internal UUIDs, including historical aliases. Admins can add or edit shared player-card details (photo, age, club, and ranking). Admins can also delete a profile and its login; historical scores remain, but the deleted player's name and profile links are anonymized so opponents' stats are preserved. Photos are stored with profile data in SQLite/Turso; uploaded files are compressed to fit the 675 KB limit. Profiles and tournament history use `/api/players`, `/api/players/:name`, and `/api/tournament-history`; local development stores these in the same SQLite database. Forecasts are estimates from recorded results, not official rankings or betting advice. Triple Crown badges remain unavailable until tournaments track three event categories.

## Excel roster import and player IDs
Admins can import `.xlsx`, `.xls`, or `.csv` rosters from **Setup → Players & Groups** or **Check-In**. The wizard selects a worksheet, maps its headings to profile fields, and previews detected matches before replacing the current event roster. Existing players are matched by unique player ID, email, full name, nickname, or known alias across saved profiles and tournament rosters; duplicate rows are skipped, and ambiguous matches block import. Missing profiles are created, while existing profile details are preserved and only blank fields are filled.

Every player profile has a unique six-digit code shown on player cards and used for player lookup. The stable UUID remains internal to preserve roster and match links. Existing database profiles are assigned codes during schema migration, and profiles are also created for legacy tournament-roster players. Imports can match an existing player by six-digit code or a legacy UUID. `/api/player-import/directory` and `/api/player-import` are admin-key protected; the spreadsheet is parsed in the browser and only the mapped player records are sent to the app.

## Tournament library and rules
Tournament setup uses a five-step flow for event details, format and scoring, players and groups, ranking rules, and a final review. Changes save as the organizer moves through the steps. Round 2 ranks all Round 1 players by configured Win Points and tie-breakers, then places consecutive ranks into the admin-selected groups; each group must have at least eight players, and its top eight advance to that group's semi-finals. Group schedules assign two non-overlapping matches to separate courts in each round when possible. Visible match and player-score views refresh from the backend every two seconds. In **Players & Groups**, admins search a card-based profile picker by name, six-digit code, or club, or create a new profile first; arbitrary unlinked names cannot be added through the manual-add control. The selected profile UUID is saved internally with the tournament, and the score history is recalculated from completed match results. Admin profile creation and edits require `ADMIN_SYNC_KEY` when using the backend. Admins can also drag a player by the handle into another group; the move menu remains available as a touch-friendly alternative. Moving a group leader assigns the next available player as the old group's leader and makes the moved player leader if the destination has none. Import or replace the roster from **Setup → Players & Groups**; the Check-In screen also keeps its import shortcut. Navigation groups setup and saved tournaments, match rounds and brackets, player performance and attendance, plus event rules. The **Tournaments** page separates current/upcoming events from completed or past events; opening an event loads its schedule, standings, and results. Organizers can add event-specific rule notes under **Tournament → Setup**. Players and guests can read the published notes alongside the tournament's configured scoring, progression, and ranking rules.

For semi-finals with eight qualifiers in a group, the top four seeds are each randomly paired with a distinct player from the bottom four to form doubles teams. The resulting draw is saved with the tournament.

Admins can permanently delete a tournament from its card in the **Tournaments** library. Deletion removes the tournament, all match results, check-ins, and tournament-derived player match history and statistics. Shared player profiles are retained. The app requires at least one tournament to remain.
