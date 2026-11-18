# SBE Light Vs Dark Side Tournament — Vercel + Turso

The app is served from `public/index.html`; Vercel runs the Express API in `badminton-backend/server.js`. Tournament state and player check-ins are stored in **Turso (libSQL), a hosted SQLite-compatible database**. Vercel's function filesystem is temporary, so do not use a local `.db` file for persistent production data.

## Deploy to Vercel
1. Import this GitHub repository into Vercel with the repository root as the project root.
2. Create a Turso database:
   ```bash
   turso db create badminton-tournament
   turso db show badminton-tournament --url
   ```
3. Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as Vercel project environment variables, then deploy. The API creates its tables automatically on first request.
4. Open the Vercel URL. Cloud Sync uses the app's same-origin `/api` endpoints by default; no backend URL is needed.

## Run locally
1. From the repository root, install and start:
   ```bash
   npm install
   npm start
   ```
Without Turso environment variables, local development uses `badminton-backend/local.db`. To use Turso locally instead, copy `.env.example` to `.env` in this directory and set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. The app and API are available at `http://localhost:3001`.
