require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

let db;
function getDb() {
  if (!db) {
    const databaseUrl = process.env.TURSO_DATABASE_URL
      || (!process.env.VERCEL ? 'file:./badminton-backend/local.db' : '');
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!databaseUrl || (databaseUrl.startsWith('file:') && process.env.VERCEL) || (!databaseUrl.startsWith('file:') && !authToken)) {
      throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables.');
    }
    const options = { url: databaseUrl };
    if (authToken) options.authToken = authToken;
    db = createClient(options);
  }
  return db;
}

let schemaPromise;
async function initSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS tournaments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          date TEXT,
          venue TEXT,
          phase TEXT,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS player_checkins (
          tournament_id TEXT NOT NULL,
          player_name TEXT NOT NULL,
          group_name TEXT,
          skill INTEGER DEFAULT 5,
          checked_in INTEGER NOT NULL DEFAULT 1,
          checked_in_at TEXT NOT NULL,
          source TEXT DEFAULT 'qr',
          PRIMARY KEY (tournament_id, player_name)
        )
      `);
    })().catch(err => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

app.use(async (_req, res, next) => {
  try {
    await initSchema();
    next();
  } catch (err) {
    console.error('Failed to initialize Turso schema:', err);
    res.status(500).json({ error: 'Database is unavailable' });
  }
});

function checkAdminKey(req, res, next) {
  const requiredKey = process.env.ADMIN_SYNC_KEY;
  if (!requiredKey) return next();
  const provided = req.headers['x-sync-key'];
  if (provided !== requiredKey) {
    return res.status(401).json({ error: 'Invalid sync key' });
  }
  next();
}

app.get('/api/health', async (_req, res) => {
  try {
    await getDb().execute('SELECT 1');
    res.json({
      ok: true,
      db: process.env.TURSO_DATABASE_URL && !process.env.TURSO_DATABASE_URL.startsWith('file:') ? 'turso' : 'sqlite'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List all tournaments
app.get('/api/tournaments', async (_req, res) => {
  try {
    const result = await getDb().execute(
      'SELECT id, name, date, venue, phase, updated_at FROM tournaments ORDER BY updated_at DESC'
    );
    res.json({ tournaments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get one tournament
app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT data, updated_at FROM tournaments WHERE id = ?',
      args: [req.params.id]
    });
    if (result.rows.length === 0) {
      return res.json({ exists: false, data: null });
    }
    const row = result.rows[0];
    res.json({ exists: true, data: JSON.parse(row.data), updatedAt: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upsert one tournament
app.put('/api/tournaments/:id', checkAdminKey, async (req, res) => {
  try {
    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid tournament state payload' });
    }
    const id = req.params.id;
    const cfg = payload.config || {};
    const now = new Date().toISOString();
    await getDb().execute({
      sql: `INSERT INTO tournaments (id, name, date, venue, phase, data, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              date = excluded.date,
              venue = excluded.venue,
              phase = excluded.phase,
              data = excluded.data,
              updated_at = excluded.updated_at`,
      args: [id, cfg.name || 'Untitled Tournament', cfg.date || null, cfg.venue || null, payload.phase || 'setup', JSON.stringify(payload), now]
    });
    res.json({ ok: true, id, updatedAt: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete one tournament
app.delete('/api/tournaments/:id', checkAdminKey, async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM player_checkins WHERE tournament_id = ?', args: [req.params.id] });
    await getDb().execute({ sql: 'DELETE FROM tournaments WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check in a player for a specific tournament
app.post('/api/tournaments/:id/checkin', async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { playerName, groupName, skill, checkedIn, time, source, walkIn } = req.body || {};
    if (!playerName) return res.status(400).json({ error: 'playerName is required' });

    const nowTime = time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (checkedIn === false) {
      await getDb().execute({
        sql: 'DELETE FROM player_checkins WHERE tournament_id = ? AND player_name = ?',
        args: [tournamentId, playerName]
      });
    } else {
      await getDb().execute({
        sql: `INSERT INTO player_checkins (tournament_id, player_name, group_name, skill, checked_in, checked_in_at, source)
              VALUES (?, ?, ?, ?, 1, ?, ?)
              ON CONFLICT(tournament_id, player_name) DO UPDATE SET
                group_name = COALESCE(excluded.group_name, player_checkins.group_name),
                skill = COALESCE(excluded.skill, player_checkins.skill),
                checked_in = 1,
                checked_in_at = excluded.checked_in_at,
                source = excluded.source`,
        args: [tournamentId, playerName, groupName || null, Number(skill) || 5, nowTime, source || 'qr']
      });
    }

    const existing = await getDb().execute({
      sql: 'SELECT data FROM tournaments WHERE id = ?',
      args: [tournamentId]
    });
    if (existing.rows.length > 0) {
      const state = JSON.parse(existing.rows[0].data);
      if (!state.checkIns) state.checkIns = {};
      if (!state.playerSkills) state.playerSkills = {};
      if (checkedIn === false) {
        delete state.checkIns[playerName];
      } else {
        state.checkIns[playerName] = { checkedIn: true, time: nowTime, source: source || 'qr' };
      }
      if (skill) state.playerSkills[playerName] = Math.max(1, Math.min(10, Number(skill)));
      if (walkIn && Array.isArray(state.groups) && state.groups.length > 0) {
        const alreadyIn = state.groups.some(g => (g.players || []).includes(playerName));
        if (!alreadyIn) {
          let targetIdx = 0;
          state.groups.forEach((g, idx) => {
            if (g.players.length < state.groups[targetIdx].players.length) targetIdx = idx;
          });
          state.groups[targetIdx].players.push(playerName);
        }
      }
      await getDb().execute({
        sql: 'UPDATE tournaments SET data = ?, updated_at = ? WHERE id = ?',
        args: [JSON.stringify(state), new Date().toISOString(), tournamentId]
      });
    }

    res.json({ ok: true, tournamentId, playerName, checkedIn: checkedIn !== false, time: nowTime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.use(express.static(require('path').join(__dirname, '..', 'public')));
  const port = process.env.PORT || 3001;
  initSchema()
    .then(() => {
      app.listen(port, () => console.log(`Multi-tournament API listening on port ${port}`));
    })
    .catch(err => {
      console.error('Failed to initialize Turso schema:', err);
      process.exitCode = 1;
    });
}

module.exports = app;
