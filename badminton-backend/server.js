require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const { promisify } = require('util');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const scrypt = promisify(crypto.scrypt);
const PLAYER_SESSION_COOKIE = 'sbe_player_session';
const PLAYER_SESSION_SECONDS = 30 * 24 * 60 * 60;
const PROFILE_VISIBILITY_FIELDS = [
  'name', 'nickname', 'photoUrl', 'age', 'gender', 'club', 'ranking', 'country', 'state', 'city',
  'emergencyContact', 'playingHand', 'preferredEvents', 'email'
];

class ValidationError extends Error {}

let db;
function getDatabaseUrl() {
  return process.env.SBE_TURSO_DATABASE_URL
    || process.env.TURSO_DATABASE_URL
    || (!process.env.VERCEL ? 'file:./badminton-backend/local.db' : '');
}

function getDb() {
  if (!db) {
    const databaseUrl = getDatabaseUrl();
    const authToken = process.env.SBE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;
    if (!databaseUrl || (databaseUrl.startsWith('file:') && process.env.VERCEL) || (!databaseUrl.startsWith('file:') && !authToken)) {
      throw new Error('Configure SBE_TURSO_DATABASE_URL (or TURSO_DATABASE_URL) and SBE_TURSO_AUTH_TOKEN (or TURSO_AUTH_TOKEN) environment variables.');
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
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS player_profiles (
          player_id TEXT,
          player_code TEXT,
          player_name TEXT PRIMARY KEY,
          photo_url TEXT NOT NULL DEFAULT '',
          age INTEGER,
          club TEXT NOT NULL DEFAULT '',
          ranking TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        )
      `);
      const profileColumns = [
        ['player_id', 'TEXT'],
        ['player_code', 'TEXT'],
        ['nickname', "TEXT NOT NULL DEFAULT ''"],
        ['gender', "TEXT NOT NULL DEFAULT ''"],
        ['country', "TEXT NOT NULL DEFAULT ''"],
        ['state', "TEXT NOT NULL DEFAULT ''"],
        ['city', "TEXT NOT NULL DEFAULT ''"],
        ['emergency_contact', "TEXT NOT NULL DEFAULT ''"],
        ['playing_hand', "TEXT NOT NULL DEFAULT ''"],
        ['preferred_events', "TEXT NOT NULL DEFAULT '[]'"],
        ['email', "TEXT NOT NULL DEFAULT ''"],
        ['visibility', "TEXT NOT NULL DEFAULT '{}'"],
        ['aliases', "TEXT NOT NULL DEFAULT '[]'"]
      ];
      const profileInfo = await getDb().execute('PRAGMA table_info(player_profiles)');
      const existingColumns = new Set(profileInfo.rows.map(column => String(column.name)));
      for (const [name, definition] of profileColumns) {
        if (!existingColumns.has(name)) {
          await getDb().execute(`ALTER TABLE player_profiles ADD COLUMN ${name} ${definition}`);
        }
      }
      const profileRows = await getDb().execute('SELECT player_name, player_id, player_code FROM player_profiles ORDER BY player_name');
      const seenPlayerIds = new Set();
      const seenPlayerCodes = new Set();
      for (const row of profileRows.rows) {
        const playerId = String(row.player_id || '').toLowerCase();
        if (!isPlayerId(playerId) || seenPlayerIds.has(playerId)) {
          const replacementId = crypto.randomUUID();
          await getDb().execute({
            sql: 'UPDATE player_profiles SET player_id = ? WHERE player_name = ?',
            args: [replacementId, row.player_name]
          });
          seenPlayerIds.add(replacementId);
        } else {
          if (String(row.player_id) !== playerId) {
            await getDb().execute({
              sql: 'UPDATE player_profiles SET player_id = ? WHERE player_name = ?',
              args: [playerId, row.player_name]
            });
          }
          seenPlayerIds.add(playerId);
        }
        const playerCode = String(row.player_code || '');
        if (!/^\d{6}$/.test(playerCode) || seenPlayerCodes.has(playerCode)) {
          const replacementCode = generateUniquePlayerCode(seenPlayerCodes);
          await getDb().execute({
            sql: 'UPDATE player_profiles SET player_code = ? WHERE player_name = ?',
            args: [replacementCode, row.player_name]
          });
          seenPlayerCodes.add(replacementCode);
        } else {
          seenPlayerCodes.add(playerCode);
        }
      }
      await getDb().execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_player_profiles_player_id ON player_profiles(player_id)');
      await getDb().execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_player_profiles_player_code ON player_profiles(player_code)');
      const tournamentRows = await getDb().execute('SELECT id, data FROM tournaments');
      const rosterNames = [];
      for (const row of tournamentRows.rows) {
        const tournament = JSON.parse(row.data);
        rosterNames.push(...getTournamentRosterNames(tournament));
      }
      const checkInRows = await getDb().execute('SELECT player_name FROM player_checkins');
      rosterNames.push(...checkInRows.rows.map(row => row.player_name));
      await ensurePlayerProfiles(rosterNames);
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS player_accounts (
          id TEXT PRIMARY KEY,
          player_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const accountInfo = await getDb().execute('PRAGMA table_info(player_accounts)');
      if (!accountInfo.rows.some(column => String(column.name) === 'must_change_password')) {
        await getDb().execute('ALTER TABLE player_accounts ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
      }
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS player_sessions (
          token_hash TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (account_id) REFERENCES player_accounts(id) ON DELETE CASCADE
        )
      `);
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS player_invites (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          target_name TEXT,
          target_email TEXT,
          contact_type TEXT,
          contact_value TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          max_uses INTEGER,
          used_count INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT
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

function validAdminKey(req) {
  const requiredKey = process.env.ADMIN_SYNC_KEY;
  const providedKey = req.headers['x-sync-key'];
  if (!requiredKey || typeof providedKey !== 'string') return false;
  const required = Buffer.from(requiredKey);
  const provided = Buffer.from(providedKey);
  return required.length === provided.length && crypto.timingSafeEqual(required, provided);
}

async function requireAdminKey(req, res, next) {
  try {
    if (await findPlayerSession(req)) {
      return res.status(403).json({ error: 'Player accounts cannot perform admin actions' });
    }
    if (!process.env.ADMIN_SYNC_KEY) {
      return res.status(503).json({ error: 'Set ADMIN_SYNC_KEY on the backend and in the app Cloud Sync settings first' });
    }
    if (!validAdminKey(req)) return res.status(401).json({ error: 'Invalid admin sync key' });
    next();
  } catch (err) {
    console.error('Failed to validate admin permission:', err);
    res.status(500).json({ error: 'Admin permission check is unavailable' });
  }
}

function normalizePlayerName(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

function normalizeImportName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function isPlayerId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function generateUniquePlayerCode(usedCodes) {
  const range = 900000;
  const start = crypto.randomInt(100000, 1000000) - 100000;
  for (let offset = 0; offset < range; offset++) {
    const code = String(100000 + ((start + offset) % range));
    if (!usedCodes.has(code)) return code;
  }
  throw new Error('All six-digit player codes are in use');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return '';
}

function setPlayerCookie(req, res, token, maxAge) {
  const isSecure = process.env.VERCEL || req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const secure = isSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${PLAYER_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`);
}

function clearPlayerCookie(req, res) {
  setPlayerCookie(req, res, '', 0);
}

async function findPlayerSession(req) {
  const token = getCookie(req, PLAYER_SESSION_COOKIE);
  if (!token) return null;
  const now = new Date().toISOString();
  const result = await getDb().execute({
    sql: `SELECT s.account_id AS accountId, a.player_name AS playerName, a.email,
                 a.must_change_password AS mustChangePassword
          FROM player_sessions s
          JOIN player_accounts a ON a.id = s.account_id
          WHERE s.token_hash = ? AND s.expires_at > ?`,
    args: [hashToken(token), now]
  });
  if (!result.rows.length) {
    await getDb().execute({
      sql: 'DELETE FROM player_sessions WHERE token_hash = ?',
      args: [hashToken(token)]
    });
    return null;
  }
  return result.rows[0];
}

async function requirePlayer(req, res, next) {
  try {
    const session = await findPlayerSession(req);
    if (!session) return res.status(401).json({ error: 'Player login required' });
    req.playerSession = session;
    const allowedDuringPasswordChange =
      (req.method === 'GET' && req.path === '/api/player-auth/me') ||
      (req.method === 'PUT' && req.path === '/api/player-auth/me/password') ||
      (req.method === 'DELETE' && req.path === '/api/player-auth/me') ||
      (req.method === 'POST' && req.path === '/api/player-auth/logout');
    if (Number(session.mustChangePassword) && !allowedDuringPasswordChange) {
      return res.status(403).json({
        error: 'Change your temporary password before continuing',
        code: 'PASSWORD_CHANGE_REQUIRED'
      });
    }
    next();
  } catch (err) {
    console.error('Failed to validate player session:', err);
    res.status(500).json({ error: 'Player authentication is unavailable' });
  }
}

async function denyPlayerWrite(req, res, next) {
  try {
    if (await findPlayerSession(req)) return res.status(403).json({ error: 'Player accounts cannot modify tournament data' });
    next();
  } catch (err) {
    console.error('Failed to validate player write permission:', err);
    res.status(500).json({ error: 'Permission check is unavailable' });
  }
}

async function hashPassword(password, salt) {
  return scrypt(password, salt, 64);
}

function parseJsonField(value, fallback) {
  return value ? JSON.parse(value) : fallback;
}

function getProfileVisibility(value) {
  const supplied = typeof value === 'string' ? parseJsonField(value, {}) : (value || {});
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new ValidationError('Profile visibility must be an object');
  }
  PROFILE_VISIBILITY_FIELDS.forEach(field => {
    if (supplied[field] !== undefined && typeof supplied[field] !== 'boolean') {
      throw new ValidationError(`Visibility for ${field} must be true or false`);
    }
  });
  return Object.fromEntries(PROFILE_VISIBILITY_FIELDS.map(field => [field, supplied[field] !== false]));
}

function serializePlayerProfile(row, publicView) {
  const visibility = getProfileVisibility(row.visibility);
  const profile = {
    playerId: row.player_id || '',
    playerCode: row.player_code || '',
    name: row.player_name,
    displayName: visibility.name ? row.player_name : (row.nickname || 'Player'),
    aliases: parseJsonField(row.aliases, []),
    photoUrl: row.photo_url || '',
    age: row.age === null || row.age === undefined ? null : Number(row.age),
    nickname: row.nickname || '',
    gender: row.gender || '',
    club: row.club || '',
    ranking: row.ranking || '',
    country: row.country || '',
    state: row.state || '',
    city: row.city || '',
    emergencyContact: row.emergency_contact || '',
    playingHand: row.playing_hand || '',
    preferredEvents: parseJsonField(row.preferred_events, []),
    email: row.email || '',
    visibility
  };
  if (publicView) {
    PROFILE_VISIBILITY_FIELDS.forEach(field => {
      if (!visibility[field] && field !== 'name') profile[field] = field === 'preferredEvents' ? [] : '';
    });
    if (!visibility.name) profile.aliases = [];
  }
  return profile;
}

async function getPlayerProfile(name) {
  const result = await getDb().execute({
    sql: 'SELECT * FROM player_profiles WHERE player_name = ? COLLATE NOCASE LIMIT 1',
    args: [String(name || '').trim()]
  });
  return result.rows[0] || null;
}

async function getProfileByName(name) {
  const cleanName = normalizePlayerName(name);
  const exact = await getPlayerProfile(name);
  if (exact) return exact;
  const profiles = await getDb().execute('SELECT * FROM player_profiles');
  return profiles.rows.find(profile =>
    parseJsonField(profile.aliases, []).some(alias => normalizePlayerName(alias) === cleanName)
  ) || null;
}

async function allocatePlayerCode(executor) {
  const result = await executor.execute('SELECT player_code FROM player_profiles WHERE player_code IS NOT NULL');
  const usedCodes = new Set(result.rows.map(row => String(row.player_code)));
  return generateUniquePlayerCode(usedCodes);
}

function isValidPlayerCode(value) {
  return /^\d{6}$/.test(String(value || ''));
}

function validHttpUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_err) {
    return false;
  }
}

function validProfilePhoto(value) {
  if (!value) return true;
  const photo = String(value);
  if (photo.startsWith('data:')) {
    const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
    return Boolean(match && photo.length <= 900000 && Math.floor(match[1].length * 3 / 4) <= 675000);
  }
  return photo.length <= 2048 && validHttpUrl(photo);
}

function normalizeProfileInput(input, current) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = typeof body.name === 'string' ? body.name.trim() : current?.player_name || '';
  if (!name || name.length > 120) throw new ValidationError('Full name must be between 1 and 120 characters');

  const stringField = (field, column, maxLength) => {
    const value = body[field] === undefined ? (current?.[column] || '') : body[field];
    if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
    const normalized = value.trim();
    if (normalized.length > maxLength) throw new ValidationError(`${field} must be ${maxLength} characters or fewer`);
    return normalized;
  };
  const photoUrl = stringField('photoUrl', 'photo_url', 900000);
  if (!validProfilePhoto(photoUrl)) {
    throw new ValidationError('Photo must be an HTTP(S) URL or a JPEG, PNG, or WebP image under 675 KB');
  }
  const email = stringField('email', 'email', 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Enter a valid email address');
  const preferredEvents = body.preferredEvents === undefined
    ? parseJsonField(current?.preferred_events, [])
    : body.preferredEvents;
  if (!Array.isArray(preferredEvents) || preferredEvents.some(event => !['Singles', 'Doubles', 'Mixed'].includes(event))) {
    throw new ValidationError('Preferred events must be Singles, Doubles, or Mixed');
  }
  const playingHand = body.playingHand === undefined ? (current?.playing_hand || '') : body.playingHand;
  if (playingHand && !['Right', 'Left'].includes(playingHand)) throw new ValidationError('Playing hand must be Right or Left');
  const visibility = getProfileVisibility(body.visibility === undefined ? current?.visibility : body.visibility);
  return {
    name,
    photoUrl,
    nickname: stringField('nickname', 'nickname', 80),
    gender: stringField('gender', 'gender', 40),
    club: stringField('club', 'club', 120),
    country: stringField('country', 'country', 80),
    state: stringField('state', 'state', 80),
    city: stringField('city', 'city', 80),
    emergencyContact: stringField('emergencyContact', 'emergency_contact', 200),
    playingHand,
    preferredEvents: [...new Set(preferredEvents)],
    email,
    visibility
  };
}

async function getRosterNames() {
  const names = new Map();
  const profiles = await getDb().execute('SELECT player_name FROM player_profiles ORDER BY player_name');
  profiles.rows.forEach(row => names.set(normalizePlayerName(row.player_name), row.player_name));
  const tournaments = await getDb().execute('SELECT id, data FROM tournaments');
  tournaments.rows.forEach(row => {
    const tournament = JSON.parse(row.data);
    if (!tournament || typeof tournament !== 'object') throw new Error(`Invalid tournament data for ${row.id}`);
    getTournamentRosterNames(tournament).forEach(name => {
      const cleanName = String(name || '').trim();
      if (cleanName) names.set(normalizePlayerName(cleanName), cleanName);
    });
  });
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function getTournamentRosterNames(tournament) {
  if (!tournament || typeof tournament !== 'object') return [];
  const names = [];
  const addPlayer = value => {
    String(value || '').split(/\s*&\s*/).forEach(name => {
      const cleanName = name.trim();
      if (cleanName && !/^(TBD|Seed\s+\d+)$/i.test(cleanName)) names.push(cleanName);
    });
  };
  (Array.isArray(tournament.groups) ? tournament.groups : [])
    .forEach(group => (Array.isArray(group?.players) ? group.players : []).forEach(addPlayer));
  Object.values(tournament.qr2Pools || {}).forEach(pool => (Array.isArray(pool) ? pool : []).forEach(addPlayer));
  const matchLists = [
    tournament.qr1Matches,
    ...Object.values(tournament.qr2Matches || {}),
    ...Object.values(tournament.semis || {})
  ];
  matchLists.forEach(list => {
    (Array.isArray(list) ? list : []).forEach(match => {
      if (!match) return;
      addPlayer(match.p1 || match.t1);
      addPlayer(match.p2 || match.t2);
    });
  });
  Object.values(tournament.finals || {}).forEach(final => {
    if (!final) return;
    addPlayer(final.p1 || final.t1);
    addPlayer(final.p2 || final.t2);
  });
  Object.keys(tournament.checkIns || {}).forEach(addPlayer);
  return names;
}

async function ensurePlayerProfiles(names, executor) {
  const database = executor || getDb();
  const existing = await database.execute('SELECT player_name, aliases FROM player_profiles');
  const known = new Set();
  existing.rows.forEach(profile => [profile.player_name, ...parseJsonField(profile.aliases, [])].forEach(name => {
    const key = normalizeImportName(name);
    if (key) known.add(key);
  }));
  for (const value of names) {
    const playerName = String(value || '').trim();
    const key = normalizeImportName(playerName);
    if (!key || /^(TBD|Seed\s+\d+)$/i.test(playerName) || known.has(key)) continue;
    const playerCode = await allocatePlayerCode(database);
    await database.execute({
      sql: 'INSERT INTO player_profiles (player_id, player_code, player_name, updated_at) VALUES (?, ?, ?, ?)',
      args: [crypto.randomUUID(), playerCode, playerName, new Date().toISOString()]
    });
    known.add(key);
  }
}

function getTournamentPlayerProfileIds(tournament, profiles) {
  const idsByName = new Map();
  const ambiguousNames = new Set();
  profiles.forEach(profile => {
    const playerId = String(profile.player_id || '');
    [profile.player_name, ...parseJsonField(profile.aliases, [])].forEach(name => {
      const key = normalizeImportName(name);
      if (!key || ambiguousNames.has(key)) return;
      const existingId = idsByName.get(key);
      if (existingId && existingId !== playerId) {
        idsByName.delete(key);
        ambiguousNames.add(key);
        return;
      }
      idsByName.set(key, playerId);
    });
  });
  const links = {};
  getTournamentRosterNames(tournament).forEach(name => {
    const key = normalizeImportName(name);
    const playerId = idsByName.get(key);
    if (key && playerId && !ambiguousNames.has(key)) links[key] = playerId;
  });
  return links;
}

async function getActiveInvite(token) {
  if (!/^[a-f0-9]{64}$/i.test(String(token || ''))) return null;
  const result = await getDb().execute({
    sql: 'SELECT * FROM player_invites WHERE token_hash = ?',
    args: [hashToken(token)]
  });
  const invite = result.rows[0];
  const expiration = invite ? Date.parse(invite.expires_at) : NaN;
  if (!invite || invite.revoked_at || !Number.isFinite(expiration) || expiration <= Date.now()) return null;
  if (invite.max_uses !== null && Number(invite.used_count) >= Number(invite.max_uses)) return null;
  return invite;
}

function verifyPlayerPassword(password, salt, expectedHash) {
  return hashPassword(password, salt).then(actual => {
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
}

async function persistPlayerProfile(profile, options) {
  const current = options.current || null;
  const playerId = current?.player_id || options.playerId || crypto.randomUUID();
  const age = options.age === undefined ? (current?.age ?? null) : options.age;
  const ranking = options.ranking === undefined ? (current?.ranking || '') : options.ranking;
  const aliases = parseJsonField(current?.aliases, []);
  if (current && normalizePlayerName(current.player_name) !== normalizePlayerName(profile.name) &&
    !aliases.some(alias => normalizePlayerName(alias) === normalizePlayerName(current.player_name))) {
    aliases.push(current.player_name);
  }
  (options.aliasesToAdd || []).forEach(alias => {
    const cleanAlias = String(alias || '').trim();
    if (cleanAlias && normalizeImportName(cleanAlias) !== normalizeImportName(profile.name) &&
      !aliases.some(existing => normalizeImportName(existing) === normalizeImportName(cleanAlias))) {
      aliases.push(cleanAlias);
    }
  });
  const keptAliases = aliases.filter(alias => normalizePlayerName(alias) !== normalizePlayerName(profile.name));
  const updatedAt = new Date().toISOString();
  const ownsTransaction = !options.transaction;
  const transaction = options.transaction || await getDb().transaction('write');
  try {
    let playerCode = current?.player_code || '';
    if (!playerCode) {
      const requestedCode = options.playerCode || '';
      if (requestedCode && !isValidPlayerCode(requestedCode)) {
        throw new ValidationError('Player code must be a six-digit number');
      }
      const existingCode = requestedCode
        ? await transaction.execute({
          sql: 'SELECT player_name FROM player_profiles WHERE player_code = ?',
          args: [requestedCode]
        })
        : { rows: [] };
      if (requestedCode && existingCode.rows.length) {
        throw new ValidationError('This six-digit player code is already assigned');
      }
      playerCode = requestedCode || await allocatePlayerCode(transaction);
    }
    const values = [
      profile.name, profile.photoUrl, age, ranking, updatedAt, profile.nickname, profile.gender, profile.club,
      profile.country, profile.state, profile.city, profile.emergencyContact, profile.playingHand,
      JSON.stringify(profile.preferredEvents), profile.email, JSON.stringify(profile.visibility), JSON.stringify(keptAliases)
    ];
    if (current) {
      const result = await transaction.execute({
        sql: `UPDATE player_profiles SET
                player_name = ?, photo_url = ?, age = ?, ranking = ?, updated_at = ?, nickname = ?,
                gender = ?, club = ?, country = ?, state = ?, city = ?, emergency_contact = ?,
                playing_hand = ?, preferred_events = ?, email = ?, visibility = ?, aliases = ?
              WHERE player_name = ?`,
        args: [...values, current.player_name]
      });
      if (!Number(result.rowsAffected)) throw new Error('Player profile no longer exists');
    } else {
      await transaction.execute({
        sql: `INSERT INTO player_profiles
                (player_id, player_code, player_name, photo_url, age, ranking, updated_at, nickname, gender, club,
                 country, state, city, emergency_contact, playing_hand, preferred_events, email, visibility, aliases)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [playerId, playerCode, ...values]
      });
    }
    if (options.accountId) {
      const accountResult = await transaction.execute({
        sql: 'UPDATE player_accounts SET player_name = ?, email = ?, updated_at = ? WHERE id = ?',
        args: [profile.name, profile.email, updatedAt, options.accountId]
      });
      if (!Number(accountResult.rowsAffected)) throw new Error('Player account no longer exists');
    }
    if (ownsTransaction) await transaction.commit();
  } catch (err) {
    if (ownsTransaction) await transaction.rollback();
    throw err;
  } finally {
    if (ownsTransaction) transaction.close();
  }
  if (ownsTransaction) return getPlayerProfile(profile.name);
  const result = await transaction.execute({
    sql: 'SELECT * FROM player_profiles WHERE player_name = ? COLLATE NOCASE LIMIT 1',
    args: [profile.name]
  });
  return result.rows[0] || null;
}

app.get('/api/health', async (_req, res) => {
  try {
    await getDb().execute('SELECT 1');
    const databaseUrl = getDatabaseUrl();
    res.json({
      ok: true,
      db: databaseUrl.startsWith('file:') ? 'sqlite' : 'turso'
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

app.get('/api/tournament-history', async (_req, res) => {
  try {
    const [result, profilesResult] = await Promise.all([
      getDb().execute('SELECT id, name, date, phase, data, updated_at FROM tournaments ORDER BY date DESC, updated_at DESC'),
      getDb().execute('SELECT player_id, player_name, aliases FROM player_profiles')
    ]);
    res.json({
      tournaments: result.rows.map(row => {
        const state = JSON.parse(row.data);
        if (!state || typeof state !== 'object' || Array.isArray(state) ||
          !state.config || typeof state.config !== 'object' || Array.isArray(state.config) ||
          (state.groups !== undefined && !Array.isArray(state.groups)) ||
          (state.qr1Matches !== undefined && !Array.isArray(state.qr1Matches)) ||
          ['qr2Pools', 'qr2Matches', 'semis', 'finals'].some(key =>
            state[key] !== undefined && (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key]))
          )) {
          throw new Error(`Invalid tournament data for ${row.id}`);
        }
        return {
          id: row.id,
          name: row.name,
          date: row.date,
          phase: row.phase,
          data: {
            tournamentId: state.tournamentId || row.id,
            config: state.config,
            groups: state.groups || [],
            qr1Matches: state.qr1Matches || [],
            qr2Pools: state.qr2Pools || {},
            qr2Matches: state.qr2Matches || {},
            semis: state.semis || {},
            finals: state.finals || {},
            playerProfileIds: {
              ...(state.playerProfileIds || {}),
              ...getTournamentPlayerProfileIds(state, profilesResult.rows)
            }
          },
          updatedAt: row.updated_at
        };
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player-auth/invites/:token', async (req, res) => {
  try {
    const invite = await getActiveInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'This invitation is invalid, expired, or already used' });
    const names = await getRosterNames();
    const accounts = await getDb().execute('SELECT player_name FROM player_accounts');
    const claimed = new Set(accounts.rows.map(row => normalizePlayerName(row.player_name)));
    res.json({
      invite: {
        kind: invite.kind,
        targetName: invite.target_name || '',
        targetEmail: invite.target_email || '',
        contactType: invite.contact_type || ''
      },
      roster: (invite.kind === 'generic' ? names.filter(name => !claimed.has(normalizePlayerName(name))) : [])
    });
  } catch (err) {
    console.error('Failed to validate player invite:', err);
    res.status(500).json({ error: 'Could not load invitation details' });
  }
});

app.post('/api/player-auth/register', async (req, res) => {
  let transaction;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const password = typeof body.password === 'string' ? body.password : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const token = String(body.inviteToken || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new ValidationError('Enter a valid email address');
    }
    if (password.length < 12 || password.length > 128) {
      throw new ValidationError('Password must be between 12 and 128 characters');
    }
    const invite = await getActiveInvite(token);
    if (!invite) return res.status(404).json({ error: 'This invitation is invalid, expired, or already used' });
    if (invite.target_email && invite.target_email.toLowerCase() !== email) {
      throw new ValidationError('Use the email address this invitation was created for');
    }

    const roster = await getRosterNames();
    let playerName;
    if (invite.kind === 'player') {
      playerName = String(invite.target_name || '').trim();
      if (!playerName) throw new Error('Player invitation has no linked player name');
    } else if (body.registrationType === 'existing') {
      const selectedName = String(body.playerName || '').trim();
      playerName = roster.find(name => normalizePlayerName(name) === normalizePlayerName(selectedName));
      if (!playerName) throw new ValidationError('Select a player from the available roster');
    } else if (body.registrationType === 'new') {
      playerName = typeof body.playerName === 'string' ? body.playerName.trim() : '';
      if (!playerName || playerName.length > 120) throw new ValidationError('Full name must be between 1 and 120 characters');
      if (roster.some(name => normalizePlayerName(name) === normalizePlayerName(playerName))) {
        throw new ValidationError('That name is already on the roster; select the existing player instead');
      }
    } else {
      throw new ValidationError('Choose an existing roster player or create a new profile');
    }

    const currentProfile = await getPlayerProfile(playerName);
    const canonicalName = currentProfile ? currentProfile.player_name : playerName;
    const existingAccount = await getDb().execute({
      sql: 'SELECT id FROM player_accounts WHERE email = ? COLLATE NOCASE OR player_name = ? COLLATE NOCASE',
      args: [email, canonicalName]
    });
    if (existingAccount.rows.length) return res.status(409).json({ error: 'This email or player already has an account' });

    const profile = normalizeProfileInput({ name: canonicalName, email }, currentProfile);
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await hashPassword(password, salt)).toString('hex');
    const accountId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PLAYER_SESSION_SECONDS * 1000).toISOString();

    transaction = await getDb().transaction('write');
    const activeInvite = await transaction.execute({
      sql: `SELECT id FROM player_invites
            WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
              AND (max_uses IS NULL OR used_count < max_uses)`,
      args: [hashToken(token), now]
    });
    if (!activeInvite.rows.length) {
      await transaction.rollback();
      return res.status(409).json({ error: 'This invitation was used or revoked while you registered' });
    }
    await transaction.execute({
      sql: `INSERT INTO player_accounts
              (id, player_name, email, password_salt, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [accountId, canonicalName, email, salt, passwordHash, now, now]
    });
    if (currentProfile) {
      await transaction.execute({
        sql: 'UPDATE player_profiles SET email = ?, updated_at = ? WHERE player_name = ?',
        args: [email, now, currentProfile.player_name]
      });
    } else {
      const playerCode = await allocatePlayerCode(transaction);
      await transaction.execute({
        sql: `INSERT INTO player_profiles
                (player_id, player_code, player_name, email, updated_at, preferred_events, visibility, aliases)
              VALUES (?, ?, ?, ?, ?, '[]', '{}', '[]')`,
        args: [crypto.randomUUID(), playerCode, canonicalName, email, now]
      });
    }
    const useResult = await transaction.execute({
      sql: `UPDATE player_invites SET used_count = used_count + 1
            WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
              AND (max_uses IS NULL OR used_count < max_uses)`,
      args: [invite.id, now]
    });
    if (!Number(useResult.rowsAffected)) {
      await transaction.rollback();
      return res.status(409).json({ error: 'This invitation was used or revoked while you registered' });
    }
    await transaction.execute({
      sql: 'INSERT INTO player_sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      args: [hashToken(sessionToken), accountId, expiresAt, now]
    });
    await transaction.commit();
    setPlayerCookie(req, res, sessionToken, PLAYER_SESSION_SECONDS);
    const savedProfile = await getPlayerProfile(canonicalName);
    res.status(201).json({ player: serializePlayerProfile(savedProfile, false) });
  } catch (err) {
    if (transaction) await transaction.rollback();
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (String(err.message || '').toLowerCase().includes('unique constraint')) {
      return res.status(409).json({ error: 'This email or player already has an account' });
    }
    console.error('Player registration failed:', err);
    res.status(500).json({ error: 'Player registration failed' });
  } finally {
    if (transaction) transaction.close();
  }
});

app.post('/api/player-auth/login', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const result = await getDb().execute({
      sql: 'SELECT * FROM player_accounts WHERE email = ? COLLATE NOCASE',
      args: [email]
    });
    const account = result.rows[0];
    if (!account || !await verifyPlayerPassword(password, account.password_salt, account.password_hash)) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    const profile = await getPlayerProfile(account.player_name);
    if (!profile) return res.status(500).json({ error: 'Player profile is unavailable' });
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PLAYER_SESSION_SECONDS * 1000).toISOString();
    await getDb().execute({
      sql: 'INSERT INTO player_sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      args: [hashToken(token), account.id, expiresAt, now]
    });
    setPlayerCookie(req, res, token, PLAYER_SESSION_SECONDS);
    res.json({
      player: serializePlayerProfile(profile, false),
      mustChangePassword: Boolean(Number(account.must_change_password))
    });
  } catch (err) {
    console.error('Player login failed:', err);
    res.status(500).json({ error: 'Player login is unavailable' });
  }
});

app.get('/api/player-auth/me', requirePlayer, async (req, res) => {
  try {
    const profile = await getPlayerProfile(req.playerSession.playerName);
    if (!profile) return res.status(404).json({ error: 'Player profile is unavailable' });
    res.json({
      player: serializePlayerProfile(profile, false),
      mustChangePassword: Boolean(Number(req.playerSession.mustChangePassword))
    });
  } catch (err) {
    console.error('Failed to load player account:', err);
    res.status(500).json({ error: 'Player profile is unavailable' });
  }
});

app.put('/api/player-auth/me/password', requirePlayer, async (req, res) => {
  let transaction;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < 12 || newPassword.length > 128) {
      throw new ValidationError('New password must be between 12 and 128 characters');
    }
    const accountResult = await getDb().execute({
      sql: 'SELECT password_salt, password_hash FROM player_accounts WHERE id = ?',
      args: [req.playerSession.accountId]
    });
    const account = accountResult.rows[0];
    if (!account || !await verifyPlayerPassword(currentPassword, account.password_salt, account.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (currentPassword === newPassword) {
      throw new ValidationError('Choose a new password different from your current password');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await hashPassword(newPassword, salt)).toString('hex');
    const now = new Date().toISOString();
    const currentTokenHash = hashToken(getCookie(req, PLAYER_SESSION_COOKIE));
    transaction = await getDb().transaction('write');
    const update = await transaction.execute({
      sql: `UPDATE player_accounts
            SET password_salt = ?, password_hash = ?, must_change_password = 0, updated_at = ?
            WHERE id = ?`,
      args: [salt, passwordHash, now, req.playerSession.accountId]
    });
    if (!Number(update.rowsAffected)) throw new Error('Player account no longer exists');
    await transaction.execute({
      sql: 'DELETE FROM player_sessions WHERE account_id = ? AND token_hash != ?',
      args: [req.playerSession.accountId, currentTokenHash]
    });
    await transaction.commit();
    res.json({ ok: true, mustChangePassword: false });
  } catch (err) {
    if (transaction) await transaction.rollback();
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error('Player password change failed:', err);
    res.status(500).json({ error: 'Player password could not be changed' });
  } finally {
    if (transaction) transaction.close();
  }
});

app.delete('/api/player-auth/me', requirePlayer, async (req, res) => {
  let transaction;
  try {
    transaction = await getDb().transaction('write');
    await transaction.execute({
      sql: 'DELETE FROM player_sessions WHERE account_id = ?',
      args: [req.playerSession.accountId]
    });
    const result = await transaction.execute({
      sql: 'DELETE FROM player_accounts WHERE id = ?',
      args: [req.playerSession.accountId]
    });
    if (!Number(result.rowsAffected)) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Player login account was not found' });
    }
    await transaction.commit();
    clearPlayerCookie(req, res);
    res.json({ ok: true, message: 'Player login was deleted; profile and tournament history were preserved' });
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Player account deletion failed:', err);
    res.status(500).json({ error: 'Player login could not be deleted' });
  } finally {
    if (transaction) transaction.close();
  }
});

app.put('/api/player-auth/me', requirePlayer, async (req, res) => {
  try {
    const current = await getPlayerProfile(req.playerSession.playerName);
    if (!current) return res.status(404).json({ error: 'Player profile is unavailable' });
    const profile = normalizeProfileInput(req.body, current);
    if (!profile.email) throw new ValidationError('Email address is required for player sign-in');

    const duplicateEmail = await getDb().execute({
      sql: 'SELECT id FROM player_accounts WHERE email = ? COLLATE NOCASE AND id != ?',
      args: [profile.email, req.playerSession.accountId]
    });
    if (duplicateEmail.rows.length) return res.status(409).json({ error: 'This email address is already in use' });
    const duplicateName = await getProfileByName(profile.name);
    if (duplicateName && normalizePlayerName(duplicateName.player_name) !== normalizePlayerName(current.player_name)) {
      return res.status(409).json({ error: 'This full name is already linked to another player' });
    }
    const aliases = parseJsonField(current.aliases, []);
    const knownNames = new Set([current.player_name, ...aliases].map(normalizePlayerName));
    const roster = await getRosterNames();
    if (normalizePlayerName(profile.name) !== normalizePlayerName(current.player_name) &&
      roster.some(name => normalizePlayerName(name) === normalizePlayerName(profile.name)) &&
      !knownNames.has(normalizePlayerName(profile.name))) {
      return res.status(409).json({ error: 'That name is already used in tournament records' });
    }

    const savedProfile = await persistPlayerProfile(profile, {
      current,
      accountId: req.playerSession.accountId
    });
    res.json({ player: serializePlayerProfile(savedProfile, false) });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (String(err.message || '').toLowerCase().includes('unique constraint')) {
      return res.status(409).json({ error: 'This player name or email is already in use' });
    }
    console.error('Player profile update failed:', err);
    res.status(500).json({ error: 'Player profile could not be updated' });
  }
});

app.post('/api/player-auth/logout', async (req, res) => {
  try {
    const token = getCookie(req, PLAYER_SESSION_COOKIE);
    if (token) {
      await getDb().execute({
        sql: 'DELETE FROM player_sessions WHERE token_hash = ?',
        args: [hashToken(token)]
      });
    }
    clearPlayerCookie(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error('Player logout failed:', err);
    res.status(500).json({ error: 'Player logout failed' });
  }
});

app.get('/api/players', async (_req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM player_profiles ORDER BY player_name');
    res.json({ players: result.rows.map(row => serializePlayerProfile(row, true)) });
  } catch (err) {
    console.error('Failed to load player profiles:', err);
    res.status(500).json({ error: 'Player profiles are unavailable' });
  }
});

app.get('/api/player-import/directory', requireAdminKey, async (_req, res) => {
  try {
    const [profilesResult, tournamentsResult] = await Promise.all([
      getDb().execute('SELECT * FROM player_profiles ORDER BY player_name'),
      getDb().execute('SELECT id, data FROM tournaments')
    ]);
    const rosterNames = new Map();
    const addName = name => {
      const cleanName = String(name || '').trim();
      const key = normalizeImportName(cleanName);
      if (key && !rosterNames.has(key)) rosterNames.set(key, cleanName);
    };
    profilesResult.rows.forEach(profile => addName(profile.player_name));
    tournamentsResult.rows.forEach(row => {
      const tournament = JSON.parse(row.data);
      getTournamentRosterNames(tournament).forEach(addName);
    });
    res.json({
      profiles: profilesResult.rows.map(profile => serializePlayerProfile(profile, false)),
      rosterNames: [...rosterNames.values()].sort((a, b) => a.localeCompare(b))
    });
  } catch (err) {
    console.error('Failed to load player import directory:', err);
    res.status(500).json({ error: 'Player directory is unavailable' });
  }
});

app.post('/api/player-import', requireAdminKey, async (req, res) => {
  let transaction;
  try {
    const inputRows = req.body && Array.isArray(req.body.players) ? req.body.players : null;
    if (!inputRows || inputRows.length === 0 || inputRows.length > 2000) {
      throw new ValidationError('Import must contain between 1 and 2,000 player rows');
    }

    transaction = await getDb().transaction('write');
    const profilesResult = await transaction.execute('SELECT * FROM player_profiles');
    const tournamentsResult = await transaction.execute('SELECT id, data FROM tournaments');
    const profiles = [...profilesResult.rows];
    const rosterNames = new Map();
    const addRosterName = name => {
      const cleanName = String(name || '').trim();
      const key = normalizeImportName(cleanName);
      if (!key) return;
      const names = rosterNames.get(key) || new Set();
      names.add(cleanName);
      rosterNames.set(key, names);
    };
    profiles.forEach(profile => addRosterName(profile.player_name));
    tournamentsResult.rows.forEach(row => {
      const tournament = JSON.parse(row.data);
      getTournamentRosterNames(tournament).forEach(addRosterName);
    });

    const results = [];
    const processed = new Set();
    let createdProfiles = 0;
    let matchedProfiles = 0;
    let identifiedRosterPlayers = 0;
    let duplicateRows = 0;

    for (let index = 0; index < inputRows.length; index++) {
      const input = inputRows[index];
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError(`Row ${index + 1} is not a valid player record`);
      }
      const profile = normalizeProfileInput(input, null);
      const playerId = typeof input.playerId === 'string' ? input.playerId.trim().toLowerCase() : '';
      if (playerId && !isPlayerId(playerId)) {
        throw new ValidationError(`Row ${index + 1}: Player ID must be a UUID`);
      }
      const playerCode = typeof input.playerCode === 'string' ? input.playerCode.trim() : '';
      if (playerCode && !isValidPlayerCode(playerCode)) {
        throw new ValidationError(`Row ${index + 1}: Player code must be a six-digit number`);
      }
      const age = input.age === null || input.age === '' || input.age === undefined ? null : Number(input.age);
      if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) {
        throw new ValidationError(`Row ${index + 1}: Age must be a whole number between 1 and 120`);
      }
      const ranking = input.ranking === undefined ? '' : String(input.ranking).trim();
      if (ranking.length > 120) throw new ValidationError(`Row ${index + 1}: Ranking must be 120 characters or fewer`);
      const aliasesInput = Array.isArray(input.aliases)
        ? input.aliases
        : (typeof input.aliases === 'string' ? input.aliases.split(/[;,|]/) : []);
      if (aliasesInput.length > 30 || aliasesInput.some(alias => typeof alias !== 'string' || alias.trim().length > 120)) {
        throw new ValidationError(`Row ${index + 1}: Aliases must be text values of 120 characters or fewer`);
      }
      const importedAliases = aliasesInput.map(alias => alias.trim()).filter(Boolean);

      const signals = [];
      const addSignal = (matches, label) => {
        const distinct = new Map(matches.map(match => [String(match.player_id || match.player_name), match]));
        if (distinct.size > 1) throw new ValidationError(`Row ${index + 1}: ${label} matches more than one existing player`);
        if (distinct.size) signals.push([...distinct.values()][0]);
      };
      if (playerId) {
        addSignal(profiles.filter(existing => String(existing.player_id || '').toLowerCase() === playerId), 'Player ID');
      }
      if (playerCode) {
        addSignal(profiles.filter(existing => String(existing.player_code || '') === playerCode), 'Player code');
      }
      const nameKeys = new Set([profile.name, ...importedAliases].map(normalizeImportName).filter(Boolean));
      addSignal(profiles.filter(existing => [
        existing.player_name,
        existing.nickname,
        ...parseJsonField(existing.aliases, [])
      ].some(name => nameKeys.has(normalizeImportName(name)))), 'Name or alias');
      const email = normalizePlayerName(profile.email);
      if (email) addSignal(profiles.filter(existing => normalizePlayerName(existing.email) === email), 'Email');
      const matchedProfilesById = new Map(signals.map(match => [String(match.player_id || match.player_name), match]));
      if (matchedProfilesById.size > 1) {
        throw new ValidationError(`Row ${index + 1}: Name, email, or ID point to different existing players`);
      }
      const current = matchedProfilesById.values().next().value || null;
      const nameKey = normalizeImportName(profile.name);
      const matchingRosterNames = rosterNames.get(nameKey) || new Set();
      if (!current && matchingRosterNames.size > 1) {
        throw new ValidationError(`Row ${index + 1}: This name is ambiguous in existing tournament rosters`);
      }
      const rosterName = !current && matchingRosterNames.size ? [...matchingRosterNames][0] : '';
      const canonicalName = current?.player_name || rosterName || profile.name;
      const identityKeys = [
        current?.player_id ? `id:${current.player_id}` : '',
        profile.email ? `email:${normalizePlayerName(profile.email)}` : '',
        `name:${normalizeImportName(canonicalName)}`
      ].filter(Boolean);
      if (identityKeys.some(identityKey => processed.has(identityKey))) {
        duplicateRows++;
        continue;
      }
      identityKeys.forEach(identityKey => processed.add(identityKey));

      const wasExistingProfile = Boolean(current);
      const wasExistingRosterPlayer = Boolean(rosterName);
      const storedEvents = current ? parseJsonField(current.preferred_events, []) : [];
      const mergedProfile = current ? {
        ...profile,
        name: canonicalName,
        photoUrl: current.photo_url || profile.photoUrl,
        nickname: current.nickname || profile.nickname,
        gender: current.gender || profile.gender,
        club: current.club || profile.club,
        country: current.country || profile.country,
        state: current.state || profile.state,
        city: current.city || profile.city,
        emergencyContact: current.emergency_contact || profile.emergencyContact,
        playingHand: current.playing_hand || profile.playingHand,
        preferredEvents: storedEvents.length ? storedEvents : profile.preferredEvents,
        email: current.email || profile.email,
        visibility: getProfileVisibility(current.visibility)
      } : { ...profile, name: canonicalName };
      const mergedAge = current?.age ?? age;
      const mergedRanking = current?.ranking || ranking;
      const aliasesToAdd = [...importedAliases, ...(wasExistingProfile ? [profile.name] : [])];
      const knownAliases = new Set(parseJsonField(current?.aliases, []).map(normalizeImportName));
      const hasAliasChanges = aliasesToAdd.some(alias =>
        normalizeImportName(alias) !== normalizeImportName(canonicalName) &&
        !knownAliases.has(normalizeImportName(alias))
      );
      const hasProfileChanges = !current || [
        ['photo_url', mergedProfile.photoUrl],
        ['nickname', mergedProfile.nickname],
        ['gender', mergedProfile.gender],
        ['club', mergedProfile.club],
        ['country', mergedProfile.country],
        ['state', mergedProfile.state],
        ['city', mergedProfile.city],
        ['emergency_contact', mergedProfile.emergencyContact],
        ['playing_hand', mergedProfile.playingHand],
        ['preferred_events', JSON.stringify(mergedProfile.preferredEvents)],
        ['email', mergedProfile.email],
        ['age', mergedAge],
        ['ranking', mergedRanking]
      ].some(([field, value]) => String(current[field] ?? '') !== String(value ?? '')) || hasAliasChanges;
      const savedProfile = hasProfileChanges
        ? await persistPlayerProfile(mergedProfile, {
          current,
          age: mergedAge,
          ranking: mergedRanking,
          playerId: current ? current.player_id : playerId,
          playerCode: current ? current.player_code : playerCode,
          aliasesToAdd,
          transaction
        })
        : current;

      if (!wasExistingProfile) createdProfiles++;
      else matchedProfiles++;
      if (wasExistingRosterPlayer) identifiedRosterPlayers++;
      if (!current) profiles.push(savedProfile);
      else {
        const profileIndex = profiles.findIndex(existing =>
          String(existing.player_id || existing.player_name) === String(current.player_id || current.player_name)
        );
        if (profileIndex >= 0) profiles[profileIndex] = savedProfile;
      }
      if (savedProfile.player_id) processed.add(`id:${savedProfile.player_id}`);
      addRosterName(canonicalName);
      results.push({
        name: savedProfile.player_name,
        playerId: savedProfile.player_id,
        status: wasExistingProfile ? 'matched' : wasExistingRosterPlayer ? 'existing-roster' : 'created',
        profile: serializePlayerProfile(savedProfile, false)
      });
    }

    await transaction.commit();
    res.json({ ok: true, players: results, createdProfiles, matchedProfiles, identifiedRosterPlayers, duplicateRows });
  } catch (err) {
    if (transaction) await transaction.rollback();
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (String(err.message || '').toLowerCase().includes('unique constraint')) {
      return res.status(409).json({ error: 'A player name or identifier is already in use' });
    }
    console.error('Player import failed:', err);
    res.status(500).json({ error: 'Players could not be imported' });
  } finally {
    if (transaction) transaction.close();
  }
});

app.put('/api/players/:name', requireAdminKey, async (req, res) => {
  try {
    const requestedName = req.params.name.trim();
    const current = await getPlayerProfile(requestedName);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const requestedPlayerId = typeof body.playerId === 'string' ? body.playerId.trim().toLowerCase() : '';
    const requestedPlayerCode = typeof body.playerCode === 'string' ? body.playerCode.trim() : '';
    if (requestedPlayerId && !isPlayerId(requestedPlayerId)) {
      throw new ValidationError('Player ID must be a UUID');
    }
    if (requestedPlayerCode && !isValidPlayerCode(requestedPlayerCode)) {
      throw new ValidationError('Player code must be a six-digit number');
    }
    if (current && requestedPlayerId && requestedPlayerId !== String(current.player_id || '').toLowerCase()) {
      throw new ValidationError('Player ID cannot be changed');
    }
    if (current && requestedPlayerCode && requestedPlayerCode !== String(current.player_code || '')) {
      throw new ValidationError('Player code cannot be changed');
    }
    const profile = normalizeProfileInput({ ...body, name: body.name || current?.player_name || requestedName }, current);
    const age = body.age === null || body.age === '' || body.age === undefined
      ? (current?.age ?? null)
      : Number(body.age);
    const ranking = body.ranking === undefined ? (current?.ranking || '') : String(body.ranking).trim();
    if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) {
      throw new ValidationError('Age must be a whole number between 1 and 120');
    }
    if (ranking.length > 120) throw new ValidationError('Ranking must be 120 characters or fewer');
    const duplicateName = await getProfileByName(profile.name);
    if (duplicateName && (!current || normalizePlayerName(duplicateName.player_name) !== normalizePlayerName(current.player_name))) {
      return res.status(409).json({ error: 'This full name is already linked to another player' });
    }
    const accountResult = current
      ? await getDb().execute({ sql: 'SELECT id FROM player_accounts WHERE player_name = ? COLLATE NOCASE', args: [current.player_name] })
      : { rows: [] };
    if (accountResult.rows.length && !profile.email) {
      throw new ValidationError('Player account email cannot be blank');
    }
    const savedProfile = await persistPlayerProfile(profile, {
      current,
      age,
      ranking,
      playerId: requestedPlayerId,
      playerCode: requestedPlayerCode,
      accountId: accountResult.rows[0]?.id
    });
    res.json({ ok: true, player: serializePlayerProfile(savedProfile, false), updatedAt: savedProfile.updated_at });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (String(err.message || '').toLowerCase().includes('unique constraint')) {
      return res.status(409).json({ error: 'This player name or email is already in use' });
    }
    console.error('Admin player profile update failed:', err);
    res.status(500).json({ error: 'Player profile could not be updated' });
  }
});

app.post('/api/player-accounts/:name/reset-password', requireAdminKey, async (req, res) => {
  let transaction;
  try {
    const playerName = String(req.params.name || '').trim();
    if (!playerName) throw new ValidationError('Player name is required');
    transaction = await getDb().transaction('write');
    const accountResult = await transaction.execute({
      sql: 'SELECT id, player_name FROM player_accounts WHERE player_name = ? COLLATE NOCASE',
      args: [playerName]
    });
    const account = accountResult.rows[0];
    if (!account) {
      await transaction.rollback();
      return res.status(404).json({ error: 'This player does not have a login account' });
    }

    const temporaryPassword = crypto.randomBytes(18).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await hashPassword(temporaryPassword, salt)).toString('hex');
    const now = new Date().toISOString();
    await transaction.execute({
      sql: `UPDATE player_accounts
            SET password_salt = ?, password_hash = ?, must_change_password = 1, updated_at = ?
            WHERE id = ?`,
      args: [salt, passwordHash, now, account.id]
    });
    await transaction.execute({
      sql: 'DELETE FROM player_sessions WHERE account_id = ?',
      args: [account.id]
    });
    await transaction.commit();
    res.json({
      ok: true,
      playerName: account.player_name,
      temporaryPassword,
      mustChangePassword: true
    });
  } catch (err) {
    if (transaction) await transaction.rollback();
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error('Admin player password reset failed:', err);
    res.status(500).json({ error: 'Player password could not be reset' });
  } finally {
    if (transaction) transaction.close();
  }
});

app.delete('/api/player-accounts/:name', requireAdminKey, async (req, res) => {
  let transaction;
  try {
    const playerName = String(req.params.name || '').trim();
    if (!playerName) throw new ValidationError('Player name is required');
    transaction = await getDb().transaction('write');
    const accountResult = await transaction.execute({
      sql: 'SELECT id, player_name FROM player_accounts WHERE player_name = ? COLLATE NOCASE',
      args: [playerName]
    });
    const account = accountResult.rows[0];
    if (!account) {
      await transaction.rollback();
      return res.status(404).json({ error: 'This player does not have a login account' });
    }
    await transaction.execute({
      sql: 'DELETE FROM player_sessions WHERE account_id = ?',
      args: [account.id]
    });
    await transaction.execute({
      sql: 'DELETE FROM player_accounts WHERE id = ?',
      args: [account.id]
    });
    await transaction.commit();
    res.json({
      ok: true,
      playerName: account.player_name,
      message: 'Player login was deleted; profile and tournament history were preserved'
    });
  } catch (err) {
    if (transaction) await transaction.rollback();
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error('Admin player account deletion failed:', err);
    res.status(500).json({ error: 'Player login could not be deleted' });
  } finally {
    if (transaction) transaction.close();
  }
});

app.post('/api/player-invites', requireAdminKey, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const kind = body.kind === 'generic' ? 'generic' : body.kind === 'player' ? 'player' : '';
    if (!kind) throw new ValidationError('Choose a player-specific or generic invitation');
    const targetName = typeof body.targetName === 'string' ? body.targetName.trim() : '';
    if (kind === 'player' && (!targetName || targetName.length > 120)) {
      throw new ValidationError('Enter a player name for this invitation');
    }
    const contactType = ['email', 'text', 'link'].includes(body.contactType) ? body.contactType : 'link';
    const contactValue = typeof body.contactValue === 'string' ? body.contactValue.trim() : '';
    let targetEmail = null;
    if (contactType === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactValue) || contactValue.length > 254) {
        throw new ValidationError('Enter a valid invitation email address');
      }
      targetEmail = contactValue.toLowerCase();
    } else if (contactType === 'text' && !/^\+?[0-9()\-\s]{7,24}$/.test(contactValue)) {
      throw new ValidationError('Enter a valid phone number for the text invitation');
    }
    const token = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const maxUses = kind === 'player' ? 1 : null;
    await getDb().execute({
      sql: `INSERT INTO player_invites
              (id, token_hash, kind, target_name, target_email, contact_type, contact_value,
               created_at, expires_at, max_uses)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, hashToken(token), kind, kind === 'player' ? targetName : null, targetEmail, contactType,
        contactValue || null, createdAt, expiresAt, maxUses]
    });
    res.status(201).json({
      invite: { id, token, kind, targetName, targetEmail, contactType, contactValue, createdAt, expiresAt, maxUses }
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error('Player invite creation failed:', err);
    res.status(500).json({ error: 'Player invitation could not be created' });
  }
});

app.get('/api/player-invites', requireAdminKey, async (_req, res) => {
  try {
    const result = await getDb().execute(
      `SELECT id, kind, target_name AS targetName, target_email AS targetEmail,
              contact_type AS contactType, contact_value AS contactValue, created_at AS createdAt,
              expires_at AS expiresAt, max_uses AS maxUses, used_count AS usedCount, revoked_at AS revokedAt
       FROM player_invites ORDER BY created_at DESC`
    );
    res.json({ invites: result.rows });
  } catch (err) {
    console.error('Failed to list player invites:', err);
    res.status(500).json({ error: 'Player invitations are unavailable' });
  }
});

app.post('/api/player-invites/:id/revoke', requireAdminKey, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'UPDATE player_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      args: [new Date().toISOString(), req.params.id]
    });
    if (!Number(result.rowsAffected)) return res.status(404).json({ error: 'Invitation not found or already revoked' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Player invite revocation failed:', err);
    res.status(500).json({ error: 'Player invitation could not be revoked' });
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
app.put('/api/tournaments/:id', denyPlayerWrite, checkAdminKey, async (req, res) => {
  try {
    const payload = req.body && req.body.data ? req.body.data : req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid tournament state payload' });
    }
    const id = req.params.id;
    await ensurePlayerProfiles(getTournamentRosterNames(payload));
    const profilesResult = await getDb().execute('SELECT player_id, player_name, aliases FROM player_profiles');
    payload.playerProfileIds = getTournamentPlayerProfileIds(payload, profilesResult.rows);
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
    res.json({ ok: true, id, updatedAt: now, playerProfileIds: payload.playerProfileIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete one tournament
app.delete('/api/tournaments/:id', requireAdminKey, async (req, res) => {
  let transaction;
  try {
    transaction = await getDb().transaction('write');
    await transaction.execute({
      sql: 'DELETE FROM player_checkins WHERE tournament_id = ?',
      args: [req.params.id]
    });
    const result = await transaction.execute({
      sql: 'DELETE FROM tournaments WHERE id = ?',
      args: [req.params.id]
    });
    await transaction.commit();
    res.json({ ok: true, deleted: Number(result.rowsAffected) > 0 });
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Tournament deletion failed:', err);
    res.status(500).json({ error: 'Tournament could not be deleted' });
  } finally {
    if (transaction) transaction.close();
  }
});

async function persistTournamentCheckIn(tournamentId, playerName, groupName, skill, checkedIn, time, source, walkIn) {
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
      const alreadyIn = state.groups.some(group => (group.players || []).includes(playerName));
      if (!alreadyIn) {
        let targetIdx = 0;
        state.groups.forEach((group, idx) => {
          if (group.players.length < state.groups[targetIdx].players.length) targetIdx = idx;
        });
        state.groups[targetIdx].players.push(playerName);
      }
    }
    await getDb().execute({
      sql: 'UPDATE tournaments SET data = ?, updated_at = ? WHERE id = ?',
      args: [JSON.stringify(state), new Date().toISOString(), tournamentId]
    });
  }

  if (checkedIn !== false) await ensurePlayerProfiles([playerName]);
  return { ok: true, tournamentId, playerName, checkedIn: checkedIn !== false, time: nowTime };
}

// Check in a player for a specific tournament
app.post('/api/tournaments/:id/checkin', denyPlayerWrite, async (req, res) => {
  try {
    const { playerName, groupName, skill, checkedIn, time, source, walkIn } = req.body || {};
    if (!playerName) return res.status(400).json({ error: 'playerName is required' });
    const result = await persistTournamentCheckIn(
      req.params.id,
      playerName,
      groupName,
      skill,
      checkedIn,
      time,
      source,
      walkIn
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/player-auth/tournaments/:id/checkin', requirePlayer, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.checkedIn === false || body.walkIn === true) {
      return res.status(403).json({ error: 'Player accounts can only check in their own roster entry' });
    }

    const profile = await getProfileByName(req.playerSession.playerName);
    if (!profile) return res.status(403).json({ error: 'Player profile could not be found' });

    const tournamentResult = await getDb().execute({
      sql: 'SELECT data FROM tournaments WHERE id = ?',
      args: [req.params.id]
    });
    if (!tournamentResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });

    const tournament = JSON.parse(tournamentResult.rows[0].data);
    const profileId = String(profile.player_id || '').toLowerCase();
    const profileNames = new Set([
      profile.player_name,
      ...parseJsonField(profile.aliases, [])
    ].map(normalizeImportName).filter(Boolean));
    const rosterEntries = [];
    (Array.isArray(tournament.groups) ? tournament.groups : []).forEach(group => {
      (Array.isArray(group.players) ? group.players : []).forEach(name => {
        const linkedId = String(tournament.playerProfileIds?.[normalizeImportName(name)] || '').toLowerCase();
        if ((profileId && linkedId === profileId) || profileNames.has(normalizeImportName(name))) {
          rosterEntries.push({ playerName: name, groupName: group.name || null });
        }
      });
    });
    const uniqueEntries = [...new Map(rosterEntries.map(entry => [normalizeImportName(entry.playerName), entry])).values()];
    if (uniqueEntries.length === 0) {
      return res.status(403).json({ error: 'Your player profile is not on this tournament roster' });
    }
    if (uniqueEntries.length > 1) {
      return res.status(409).json({ error: 'Your player profile matches multiple roster entries; contact the tournament admin' });
    }

    const { playerName, groupName } = uniqueEntries[0];
    if (body.playerName && normalizeImportName(body.playerName) !== normalizeImportName(playerName)) {
      return res.status(403).json({ error: 'Player accounts can only check in their own roster entry' });
    }
    const skill = Math.max(1, Math.min(10, Math.round(Number(tournament.playerSkills?.[playerName]) || 5)));
    const result = await persistTournamentCheckIn(
      req.params.id,
      playerName,
      groupName,
      skill,
      true,
      undefined,
      'player',
      false
    );
    res.json(result);
  } catch (err) {
    console.error('Player check-in failed:', err);
    res.status(500).json({ error: 'Player check-in failed' });
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
