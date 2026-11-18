# SBE Light Vs Dark Side Tournament — Turso Backend API

This Express API persists the tournament state (`config`, `groups`, `playerSkills`, `checkIns`, `qr1Matches`, `qr2Pools`, `qr2Matches`, `semis`, `finals`) in a **Turso (libSQL / SQLite)** database.

## Setup
1. Create a Turso database if you haven't already:
   ```bash
   turso db create badminton-tournament
   turso db show badminton-tournament --url
   ```
2. Copy `.env.example` to `.env` and fill in `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
3. Install dependencies and start:
   ```bash
   npm install
   npm start
   ```

## Deploy & Connect
Deploy this folder to **Render**, **Railway**, **Fly.io**, or any Node.js host with `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set as environment variables.
Then in the web app (`index.html`), click **Cloud Sync** in the header and paste your deployed backend URL (e.g. `https://your-app.onrender.com`).
