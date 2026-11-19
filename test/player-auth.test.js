const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createClient } = require('@libsql/client');

const root = path.join(__dirname, '..');

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

test('player invitations, sessions, profile ownership, and visibility', { timeout: 30000 }, async () => {
  const databasePath = path.join(__dirname, `player-auth-${process.pid}.db`);
  const databaseUrl = `file:${databasePath.replace(/\\/g, '/')}`;
  const port = await getAvailablePort();
  const seedClient = createClient({ url: databaseUrl });
  await seedClient.execute(`
    CREATE TABLE player_profiles (
      player_name TEXT PRIMARY KEY,
      photo_url TEXT NOT NULL DEFAULT '',
      age INTEGER,
      club TEXT NOT NULL DEFAULT '',
      ranking TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
  await seedClient.execute({
    sql: 'INSERT INTO player_profiles (player_name, updated_at) VALUES (?, ?)',
    args: ['Legacy Player', new Date().toISOString()]
  });
  await seedClient.close();
  const child = spawn(process.execPath, [path.join(root, 'badminton-backend', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      ADMIN_SYNC_KEY: 'player-auth-test-admin-key',
      PORT: String(port),
      TURSO_DATABASE_URL: databaseUrl,
      TURSO_AUTH_TOKEN: '',
      VERCEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminHeaders = { 'content-type': 'application/json', 'x-sync-key': 'player-auth-test-admin-key' };
  const api = async (endpoint, options) => {
    const response = await fetch(`${baseUrl}${endpoint}`, options);
    const body = await response.json();
    return { response, body };
  };

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Test backend exited early:\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch (_err) {}
      await delay(100);
    }
    assert.equal(healthy, true, `Test backend did not become ready:\n${output}`);

    const migratedDirectory = await api('/api/player-import/directory', { headers: adminHeaders });
    assert.equal(migratedDirectory.response.status, 200);
    const migratedProfile = migratedDirectory.body.profiles.find(player => player.name === 'Legacy Player');
    assert.ok(migratedProfile);
    assert.match(migratedProfile.playerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(migratedProfile.playerCode, /^\d{6}$/);

    const noKey = await api('/api/player-invites');
    assert.equal(noKey.response.status, 401);

    const savedTournament = await api('/api/tournaments/auth-test', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        tournamentId: 'auth-test',
        phase: 'setup',
        config: { name: 'Auth Test' },
        groups: [{ name: 'Group A', players: ['Roster Alice', 'Roster Bob'] }]
      })
    });
    assert.equal(savedTournament.response.status, 200);
    assert.match(savedTournament.body.playerProfileIds['roster alice'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(savedTournament.body.playerProfileIds['roster bob'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const rosterProfiles = await api('/api/players');
    assert.equal(rosterProfiles.response.status, 200);
    for (const name of ['Roster Alice', 'Roster Bob']) {
      const profile = rosterProfiles.body.players.find(player => player.name === name);
      assert.ok(profile, `Expected a profile for roster player ${name}`);
      assert.match(profile.playerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.match(profile.playerCode, /^\d{6}$/);
    }
    const rosterCodes = rosterProfiles.body.players.map(player => player.playerCode);
    assert.equal(new Set(rosterCodes).size, rosterCodes.length);

    const aliceProfile = rosterProfiles.body.players.find(player => player.name === 'Roster Alice');
    const codeImport = await api('/api/player-import', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ players: [{ name: 'Alice alternate name', playerCode: aliceProfile.playerCode }] })
    });
    assert.equal(codeImport.response.status, 200);
    assert.equal(codeImport.body.matchedProfiles, 1);
    assert.equal(codeImport.body.players[0].playerId, aliceProfile.playerId);

    const uploadedPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=';
    const profilePhotoUpdate = await api('/api/players/Legacy%20Player', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        name: migratedProfile.name,
        playerId: migratedProfile.playerId,
        playerCode: migratedProfile.playerCode,
        photoUrl: uploadedPhoto
      })
    });
    assert.equal(profilePhotoUpdate.response.status, 200);
    assert.equal(profilePhotoUpdate.body.player.photoUrl, uploadedPhoto);
    assert.equal(profilePhotoUpdate.body.player.playerCode, migratedProfile.playerCode);
    const legacyData = {
      tournamentId: 'auth-test',
      phase: 'setup',
      config: { name: 'Auth Test' },
      groups: [{ name: 'Group A', players: ['Roster Alice', 'Roster Bob'] }]
    };
    const legacyClient = createClient({ url: databaseUrl });
    await legacyClient.execute({
      sql: 'UPDATE tournaments SET data = ? WHERE id = ?',
      args: [JSON.stringify(legacyData), 'auth-test']
    });
    await legacyClient.close();
    const tournamentHistory = await api('/api/tournament-history');
    const historyEntry = tournamentHistory.body.tournaments.find(tournament => tournament.id === 'auth-test');
    assert.equal(historyEntry.data.playerProfileIds['roster alice'], savedTournament.body.playerProfileIds['roster alice']);

    const rosterImport = await api('/api/player-import', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ players: [{ name: ' roster bob ' }, { name: 'Roster Bob' }] })
    });
    assert.equal(rosterImport.response.status, 200);
    assert.equal(rosterImport.body.createdProfiles, 0);
    assert.equal(rosterImport.body.matchedProfiles, 1);
    assert.equal(rosterImport.body.duplicateRows, 1);
    assert.equal(rosterImport.body.players.length, 1);
    assert.equal(rosterImport.body.players[0].status, 'matched');
    assert.match(rosterImport.body.players[0].playerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const specificInvite = await api('/api/player-invites', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'player',
        targetName: 'Invited Player',
        contactType: 'email',
        contactValue: 'invited@example.com'
      })
    });
    assert.equal(specificInvite.response.status, 201);
    const token = specificInvite.body.invite.token;

    const inviteInfo = await api(`/api/player-auth/invites/${token}`);
    assert.equal(inviteInfo.response.status, 200);
    assert.equal(inviteInfo.body.invite.targetName, 'Invited Player');
    assert.equal(inviteInfo.body.invite.targetEmail, 'invited@example.com');

    const badEmail = await api('/api/player-auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: token, email: 'other@example.com', password: 'a-secure-test-password' })
    });
    assert.equal(badEmail.response.status, 400);

    const registration = await api('/api/player-auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: token, email: 'invited@example.com', password: 'a-secure-test-password' })
    });
    assert.equal(registration.response.status, 201);
    assert.match(registration.body.player.playerCode, /^\d{6}$/);
    const playerCookie = registration.response.headers.get('set-cookie').split(';')[0];

    const reuseInvite = await api('/api/player-auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: token, email: 'second@example.com', password: 'another-secure-password' })
    });
    assert.equal(reuseInvite.response.status, 404);

    const update = await api('/api/player-auth/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: playerCookie },
      body: JSON.stringify({
        name: 'Renamed Player',
        nickname: 'Ace',
        city: 'Hidden City',
        email: 'renamed@example.com',
        photoUrl: uploadedPhoto,
        age: 99,
        ranking: 'Cannot edit ranking',
        visibility: { name: false, city: false, email: false, ranking: false }
      })
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.body.player.name, 'Renamed Player');
    assert.equal(update.body.player.nickname, 'Ace');
    assert.equal(update.body.player.age, null);
    assert.equal(update.body.player.ranking, '');
    assert.equal(update.body.player.photoUrl, uploadedPhoto);

    const publicProfiles = await api('/api/players');
    assert.equal(publicProfiles.response.status, 200);
    const publicProfile = publicProfiles.body.players.find(player => player.displayName === 'Ace');
    assert.ok(publicProfile);
    assert.equal(publicProfile.city, '');
    assert.equal(publicProfile.email, '');
    assert.equal(publicProfile.ranking, '');
    assert.deepEqual(publicProfile.aliases, []);

    const invalidLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: 'wrong-password' })
    });
    assert.equal(invalidLogin.response.status, 401);
    const validLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: 'a-secure-test-password' })
    });
    assert.equal(validLogin.response.status, 200);
    assert.ok(validLogin.response.headers.get('set-cookie'));

    const genericInvite = await api('/api/player-invites', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ kind: 'generic', contactType: 'link' })
    });
    assert.equal(genericInvite.response.status, 201);
    const genericInfo = await api(`/api/player-auth/invites/${genericInvite.body.invite.token}`);
    assert.deepEqual(genericInfo.body.roster, ['Legacy Player', 'Roster Alice', 'Roster Bob']);
    const claimedRosterPlayer = await api('/api/player-auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken: genericInvite.body.invite.token,
        registrationType: 'existing',
        playerName: 'Roster Alice',
        email: 'alice@example.com',
        password: 'alice-secure-password'
      })
    });
    assert.equal(claimedRosterPlayer.response.status, 201);
    const aliceCookie = claimedRosterPlayer.response.headers.get('set-cookie').split(';')[0];
    const newPlayer = await api('/api/player-auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken: genericInvite.body.invite.token,
        registrationType: 'new',
        playerName: 'Brand New Player',
        email: 'new-player@example.com',
        password: 'new-player-secure-password'
      })
    });
    assert.equal(newPlayer.response.status, 201);

    const playerImport = await api('/api/player-import', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        players: [
          { name: 'roster alice', email: 'alice@example.com', club: 'Imported Club' },
          { name: 'Roster Alice', email: 'alice@example.com' },
          { name: 'Imported Player', email: 'imported@example.com' },
          { name: ' imported   player ', email: 'imported@example.com' }
        ]
      })
    });
    assert.equal(playerImport.response.status, 200);
    assert.equal(playerImport.body.createdProfiles, 1);
    assert.equal(playerImport.body.matchedProfiles, 1);
    assert.equal(playerImport.body.duplicateRows, 2);
    assert.equal(playerImport.body.players.length, 2);
    assert.equal(playerImport.body.players[0].name, 'Roster Alice');
    assert.equal(playerImport.body.players[0].profile.club, 'Imported Club');
    const importedIds = playerImport.body.players.map(player => player.playerId);
    assert.equal(new Set(importedIds).size, importedIds.length);
    assert.ok(importedIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)));

    const tournamentWrite = await api('/api/tournaments/auth-test', {
      method: 'PUT',
      headers: { ...adminHeaders, cookie: playerCookie },
      body: JSON.stringify({ config: { name: 'Player changed this' }, groups: [] })
    });
    assert.equal(tournamentWrite.response.status, 403);

    const checkinWrite = await api('/api/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: playerCookie },
      body: JSON.stringify({ playerName: 'Roster Alice' })
    });
    assert.equal(checkinWrite.response.status, 403);

    const unauthenticatedCheckIn = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(unauthenticatedCheckIn.response.status, 401);

    const nonRosterCheckIn = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: playerCookie },
      body: JSON.stringify({})
    });
    assert.equal(nonRosterCheckIn.response.status, 403);

    const otherPlayerCheckIn = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ playerName: 'Roster Bob' })
    });
    assert.equal(otherPlayerCheckIn.response.status, 403);

    const selfCheckIn = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ playerName: 'Roster Alice' })
    });
    assert.equal(selfCheckIn.response.status, 200);
    assert.equal(selfCheckIn.body.playerName, 'Roster Alice');
    assert.equal(selfCheckIn.body.checkedIn, true);
    const savedCheckIn = await api('/api/tournaments/auth-test');
    assert.equal(savedCheckIn.body.data.checkIns['Roster Alice'].checkedIn, true);
    assert.equal(savedCheckIn.body.data.checkIns['Roster Alice'].source, 'player');

    const adminInviteWrite = await api('/api/player-invites', {
      method: 'POST',
      headers: { ...adminHeaders, cookie: playerCookie },
      body: JSON.stringify({ kind: 'generic', contactType: 'link' })
    });
    assert.equal(adminInviteWrite.response.status, 403);

    const logout = await api('/api/player-auth/logout', {
      method: 'POST',
      headers: { cookie: playerCookie }
    });
    assert.equal(logout.response.status, 200);
    const missingSession = await api('/api/player-auth/me');
    assert.equal(missingSession.response.status, 401);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    for (const suffix of ['', '-shm', '-wal']) {
      try { await fs.unlink(`${databasePath}${suffix}`); } catch (_err) {}
    }
  }
});
