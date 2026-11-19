const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createClient } = require('@libsql/client');
const { buildAnalytics } = require('../public/player-analytics');

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
      SBE_TURSO_DATABASE_URL: databaseUrl,
      SBE_TURSO_AUTH_TOKEN: '',
      TURSO_DATABASE_URL: '',
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
    const publicTournamentHistory = await api('/api/tournament-history');
    assert.equal(publicTournamentHistory.response.status, 200);
    assert.ok(publicTournamentHistory.body.tournaments.some(tournament => tournament.id === 'auth-test'));

    const unchangedTournament = await api(`/api/tournaments/auth-test?since=${encodeURIComponent(savedTournament.body.updatedAt)}`);
    assert.equal(unchangedTournament.response.status, 200);
    assert.equal(unchangedTournament.body.unchanged, true);
    assert.equal(unchangedTournament.body.data, undefined);
    await delay(2);
    const updatedTournamentData = await api('/api/tournaments/auth-test');
    updatedTournamentData.body.data.config.name = 'Auth Test Updated';
    const updatedTournament = await api('/api/tournaments/auth-test', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify(updatedTournamentData.body.data)
    });
    const changedTournament = await api(`/api/tournaments/auth-test?since=${encodeURIComponent(savedTournament.body.updatedAt)}`);
    assert.equal(updatedTournament.response.status, 200);
    assert.equal(changedTournament.body.unchanged, undefined);
    assert.equal(changedTournament.body.data.config.name, 'Auth Test Updated');

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
    const playerCookieAfterPassword = validLogin.response.headers.get('set-cookie').split(';')[0];

    const passwordChange = await api('/api/player-auth/me/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: playerCookieAfterPassword },
      body: JSON.stringify({
        currentPassword: 'a-secure-test-password',
        newPassword: 'changed-secure-password'
      })
    });
    assert.equal(passwordChange.response.status, 200);
    const oldPasswordLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: 'a-secure-test-password' })
    });
    assert.equal(oldPasswordLogin.response.status, 401);
    const changedPasswordLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: 'changed-secure-password' })
    });
    assert.equal(changedPasswordLogin.response.status, 200);
    const changedPasswordCookie = changedPasswordLogin.response.headers.get('set-cookie').split(';')[0];

    const adminRename = await api('/api/players/Renamed%20Player', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Admin Renamed Player',
        playerId: update.body.player.playerId,
        playerCode: update.body.player.playerCode
      })
    });
    assert.equal(adminRename.response.status, 200);
    assert.equal(adminRename.body.player.name, 'Admin Renamed Player');
    const renamedAccount = await api('/api/player-auth/me', {
      headers: { cookie: changedPasswordCookie }
    });
    assert.equal(renamedAccount.response.status, 200);
    assert.equal(renamedAccount.body.player.name, 'Admin Renamed Player');

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
      headers: { ...adminHeaders, cookie: changedPasswordCookie },
      body: JSON.stringify({ config: { name: 'Player changed this' }, groups: [] })
    });
    assert.equal(tournamentWrite.response.status, 403);

    const guestCheckIn = await api('/api/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: 'Roster Bob' })
    });
    assert.equal(guestCheckIn.response.status, 401);

    const adminCheckIn = await api('/api/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ playerName: 'Roster Bob' })
    });
    assert.equal(adminCheckIn.response.status, 200);

    const checkinWrite = await api('/api/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: changedPasswordCookie },
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
      headers: { 'content-type': 'application/json', cookie: changedPasswordCookie },
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

    const duplicateSelfCheckIn = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ playerName: 'Roster Alice' })
    });
    assert.equal(duplicateSelfCheckIn.response.status, 409);

    const completedTournamentState = await api('/api/tournaments/auth-test');
    completedTournamentState.body.data.phase = 'completed';
    const saveCompletedTournament = await api('/api/tournaments/auth-test', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify(completedTournamentState.body.data)
    });
    assert.equal(saveCompletedTournament.response.status, 200);
    const completedTournamentCheckIn = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ playerName: 'Roster Alice' })
    });
    assert.equal(completedTournamentCheckIn.response.status, 403);

    const adminInviteWrite = await api('/api/player-invites', {
      method: 'POST',
      headers: { ...adminHeaders, cookie: changedPasswordCookie },
      body: JSON.stringify({ kind: 'generic', contactType: 'link' })
    });
    assert.equal(adminInviteWrite.response.status, 403);

    const logout = await api('/api/player-auth/logout', {
      method: 'POST',
      headers: { cookie: changedPasswordCookie }
    });
    assert.equal(logout.response.status, 200);
    const missingSession = await api('/api/player-auth/me');
    assert.equal(missingSession.response.status, 401);

    const resetWithoutKey = await api('/api/player-accounts/Admin%20Renamed%20Player/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
    assert.equal(resetWithoutKey.response.status, 401);
    const resetPassword = await api('/api/player-accounts/Admin%20Renamed%20Player/reset-password', {
      method: 'POST',
      headers: adminHeaders
    });
    assert.equal(resetPassword.response.status, 200);
    assert.equal(resetPassword.body.mustChangePassword, true);
    assert.ok(resetPassword.body.temporaryPassword.length >= 12);
    const temporaryPassword = resetPassword.body.temporaryPassword;

    const temporaryLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: temporaryPassword })
    });
    assert.equal(temporaryLogin.response.status, 200);
    assert.equal(temporaryLogin.body.mustChangePassword, true);
    const temporaryCookie = temporaryLogin.response.headers.get('set-cookie').split(';')[0];
    const blockedUntilPasswordChange = await api('/api/player-auth/tournaments/auth-test/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: temporaryCookie },
      body: JSON.stringify({ playerName: 'Roster Alice' })
    });
    assert.equal(blockedUntilPasswordChange.response.status, 403);
    assert.equal(blockedUntilPasswordChange.body.code, 'PASSWORD_CHANGE_REQUIRED');

    const forcedPasswordChange = await api('/api/player-auth/me/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: temporaryCookie },
      body: JSON.stringify({
        currentPassword: temporaryPassword,
        newPassword: 'new-after-reset-password'
      })
    });
    assert.equal(forcedPasswordChange.response.status, 200);
    const oldTemporaryLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: temporaryPassword })
    });
    assert.equal(oldTemporaryLogin.response.status, 401);
    const afterResetMe = await api('/api/player-auth/me', {
      headers: { cookie: temporaryCookie }
    });
    assert.equal(afterResetMe.response.status, 200);
    assert.equal(afterResetMe.body.mustChangePassword, false);

    const playerAfterReset = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: 'new-after-reset-password' })
    });
    assert.equal(playerAfterReset.response.status, 200);
    const playerAfterResetCookie = playerAfterReset.response.headers.get('set-cookie').split(';')[0];
    const selfDelete = await api('/api/player-auth/me', {
      method: 'DELETE',
      headers: { cookie: playerAfterResetCookie }
    });
    assert.equal(selfDelete.response.status, 200);
    const deletedPlayerSession = await api('/api/player-auth/me', {
      headers: { cookie: playerAfterResetCookie }
    });
    assert.equal(deletedPlayerSession.response.status, 401);
    const preservedPlayerProfile = await api('/api/players');
    assert.ok(preservedPlayerProfile.body.players.some(player => player.name === 'Admin Renamed Player'));
    const deletedAccountLogin = await api('/api/player-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'renamed@example.com', password: 'new-after-reset-password' })
    });
    assert.equal(deletedAccountLogin.response.status, 401);

    const playerDeleteOwnAccount = await api('/api/player-accounts/Roster%20Alice', {
      method: 'DELETE',
      headers: { ...adminHeaders, cookie: aliceCookie }
    });
    assert.equal(playerDeleteOwnAccount.response.status, 403);
    const deleteFixture = await api('/api/tournaments/delete-test', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        tournamentId: 'delete-test',
        phase: 'completed',
        config: { name: 'Delete Test' },
        groups: [{ name: 'Group A', players: ['Roster Alice', 'Roster Bob'] }],
        qr1Matches: [
          { id: 'delete-test-match', p1: 'Roster Alice', p2: 'Roster Bob', s1: 21, s2: 12, completed: true }
        ]
      })
    });
    assert.equal(deleteFixture.response.status, 200);
    const fixtureCheckIn = await api('/api/tournaments/delete-test/checkin', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ playerName: 'Roster Alice' })
    });
    assert.equal(fixtureCheckIn.response.status, 200);
    const tournamentDeleteWithoutKey = await api('/api/tournaments/delete-test', {
      method: 'DELETE'
    });
    assert.equal(tournamentDeleteWithoutKey.response.status, 401);
    const playerTournamentDelete = await api('/api/tournaments/delete-test', {
      method: 'DELETE',
      headers: { ...adminHeaders, cookie: aliceCookie }
    });
    assert.equal(playerTournamentDelete.response.status, 403);
    const adminDeleteAccount = await api('/api/player-accounts/Roster%20Alice', {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.equal(adminDeleteAccount.response.status, 200);
    const removedAdminDeletedPlayerSession = await api('/api/player-auth/me', {
      headers: { cookie: aliceCookie }
    });
    assert.equal(removedAdminDeletedPlayerSession.response.status, 401);
    const preservedAdminDeletedProfile = await api('/api/players');
    assert.ok(preservedAdminDeletedProfile.body.players.some(player => player.name === 'Roster Alice'));

    const tournamentBeforeDelete = await api('/api/tournaments/delete-test');
    assert.equal(tournamentBeforeDelete.body.data.qr1Matches[0].id, 'delete-test-match');
    const historyBeforeTournamentDelete = await api('/api/tournament-history');
    assert.ok(historyBeforeTournamentDelete.body.tournaments.some(tournament => tournament.id === 'delete-test'));
    const adminTournamentDelete = await api('/api/tournaments/delete-test', {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.equal(adminTournamentDelete.response.status, 200);
    assert.equal(adminTournamentDelete.body.deleted, true);
    const removedTournament = await api('/api/tournaments/delete-test');
    assert.deepEqual(removedTournament.body, { exists: false, data: null });
    const historyAfterTournamentDelete = await api('/api/tournament-history');
    assert.ok(!historyAfterTournamentDelete.body.tournaments.some(tournament => tournament.id === 'delete-test'));
    const profilesAfterTournamentDelete = await api('/api/players');
    assert.ok(profilesAfterTournamentDelete.body.players.some(player => player.name === 'Roster Alice'));

    const profileDeleteFixture = await api('/api/tournaments/profile-delete-test', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        tournamentId: 'profile-delete-test',
        phase: 'completed',
        config: { name: 'Profile Delete Test' },
        groups: [{ name: 'A', players: ['History Target', 'History Partner', 'History Opponent'] }],
        qr1Matches: [
          { id: 'target-singles', p1: 'History Target', p2: 'History Opponent', s1: 21, s2: 14, completed: true, winner: 'History Target' }
        ],
        finals: {
          championship: {
            id: 'target-final',
            p1: 'History Target',
            p2: 'History Opponent',
            games: [{ s1: 21, s2: 15 }, { s1: 16, s2: 21 }, { s1: 21, s2: 18 }],
            completed: true,
            winner: 'History Target'
          }
        }
      })
    });
    assert.equal(profileDeleteFixture.response.status, 200);
    const renamedTarget = await api('/api/players/History%20Target', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'History Target Renamed' })
    });
    assert.equal(renamedTarget.response.status, 200);
    const tournamentWithAlias = await api('/api/tournaments/profile-delete-test');
    tournamentWithAlias.body.data.qr1Matches.push({
      id: 'target-doubles',
      p1: 'History Target Renamed & History Partner',
      p2: 'History Opponent & Another Partner',
      s1: 17,
      s2: 21,
      completed: true,
      winner: 'History Opponent & Another Partner'
    });
    const savedAliasMatch = await api('/api/tournaments/profile-delete-test', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify(tournamentWithAlias.body.data)
    });
    assert.equal(savedAliasMatch.response.status, 200);

    const deleteTargetInvite = await api('/api/player-invites', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'player',
        targetName: 'History Target Renamed',
        contactType: 'email',
        contactValue: 'history-target@example.com'
      })
    });
    assert.equal(deleteTargetInvite.response.status, 201);
    const deleteTargetRegistration = await api('/api/player-auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken: deleteTargetInvite.body.invite.token,
        email: 'history-target@example.com',
        password: 'history-target-test-password'
      })
    });
    assert.equal(deleteTargetRegistration.response.status, 201);
    const deleteTargetCookie = deleteTargetRegistration.response.headers.get('set-cookie').split(';')[0];
    const targetCheckIn = await api('/api/tournaments/profile-delete-test/checkin', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ playerName: 'History Target', groupName: 'A', skill: 7 })
    });
    assert.equal(targetCheckIn.response.status, 200);

    const deleteProfileWithoutKey = await api('/api/players/History%20Target%20Renamed', { method: 'DELETE' });
    assert.equal(deleteProfileWithoutKey.response.status, 401);
    const deleteProfileAsPlayer = await api(`/api/players/History%20Target%20Renamed?playerId=${renamedTarget.body.player.playerId}`, {
      method: 'DELETE',
      headers: { ...adminHeaders, cookie: deleteTargetCookie }
    });
    assert.equal(deleteProfileAsPlayer.response.status, 403);
    const deleteWithStaleId = await api('/api/players/History%20Target%20Renamed?playerId=00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.equal(deleteWithStaleId.response.status, 409);
    const deleteWithInvalidId = await api('/api/players/History%20Target%20Renamed?playerId=invalid', {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.equal(deleteWithInvalidId.response.status, 400);
    const deletedProfile = await api(`/api/players/History%20Target%20Renamed?playerId=${renamedTarget.body.player.playerId}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.equal(deletedProfile.response.status, 200);
    assert.match(deletedProfile.body.anonymizedName, /^Anonymous Player [a-f0-9]{16}$/);
    assert.ok(deletedProfile.body.updatedTournamentIds.includes('profile-delete-test'));

    const invalidatedDeletedPlayerSession = await api('/api/player-auth/me', {
      headers: { cookie: deleteTargetCookie }
    });
    assert.equal(invalidatedDeletedPlayerSession.response.status, 401);
    const profilesAfterProfileDelete = await api('/api/players');
    assert.ok(!profilesAfterProfileDelete.body.players.some(player =>
      ['History Target', 'History Target Renamed'].includes(player.name)
    ));
    assert.ok(!profilesAfterProfileDelete.body.players.some(player => player.name === deletedProfile.body.anonymizedName));

    const anonymizedTournament = await api('/api/tournaments/profile-delete-test');
    const anonymizedData = anonymizedTournament.body.data;
    assert.ok(anonymizedData.groups[0].players.includes(deletedProfile.body.anonymizedName));
    assert.ok(!anonymizedData.groups[0].players.includes('History Target'));
    assert.ok(!anonymizedData.groups[0].players.includes('History Target Renamed'));
    assert.equal(anonymizedData.qr1Matches[0].p1, deletedProfile.body.anonymizedName);
    assert.equal(anonymizedData.qr1Matches[0].winner, deletedProfile.body.anonymizedName);
    assert.equal(anonymizedData.qr1Matches[0].s1, 21);
    assert.equal(anonymizedData.qr1Matches[0].s2, 14);
    assert.equal(anonymizedData.qr1Matches[0].completed, true);
    assert.equal(anonymizedData.qr1Matches[1].p1, `${deletedProfile.body.anonymizedName} & History Partner`);
    assert.equal(anonymizedData.qr1Matches[1].s1, 17);
    assert.equal(anonymizedData.qr1Matches[1].s2, 21);
    assert.equal(anonymizedData.finals.championship.winner, deletedProfile.body.anonymizedName);
    assert.deepEqual(anonymizedData.finals.championship.games, [
      { s1: 21, s2: 15 }, { s1: 16, s2: 21 }, { s1: 21, s2: 18 }
    ]);
    assert.ok(!Object.values(anonymizedData.playerProfileIds).includes(renamedTarget.body.player.playerId));
    assert.ok(!Object.keys(anonymizedData.playerProfileIds).includes('history target'));
    assert.ok(!Object.keys(anonymizedData.playerProfileIds).includes('history target renamed'));
    assert.equal(Object.keys(anonymizedData.checkIns || {}).length, 0);
    const anonymizedAnalytics = buildAnalytics(
      [{ id: 'profile-delete-test', data: anonymizedData }],
      profilesAfterProfileDelete.body.players,
      'profile-delete-test'
    );
    assert.equal(anonymizedAnalytics.getPlayer('History Opponent').matchesPlayed, 3);

    const verificationClient = createClient({ url: databaseUrl });
    const remainingCheckIns = await verificationClient.execute({
      sql: 'SELECT tournament_id FROM player_checkins WHERE tournament_id = ?',
      args: ['delete-test']
    });
    assert.equal(remainingCheckIns.rows.length, 0);
    const deletedPlayerRows = await verificationClient.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM player_profiles WHERE player_name IN (?, ?)) AS profiles,
              (SELECT COUNT(*) FROM player_accounts WHERE email = ?) AS accounts,
              (SELECT COUNT(*) FROM player_invites WHERE target_email = ? OR contact_value = ?) AS invites,
              (SELECT COUNT(*) FROM player_checkins WHERE player_name IN (?, ?)) AS checkins`,
      args: [
        'History Target', 'History Target Renamed',
        'history-target@example.com',
        'history-target@example.com', 'history-target@example.com',
        'History Target', 'History Target Renamed'
      ]
    });
    assert.equal(Number(deletedPlayerRows.rows[0].profiles), 0);
    assert.equal(Number(deletedPlayerRows.rows[0].accounts), 0);
    assert.equal(Number(deletedPlayerRows.rows[0].invites), 0);
    assert.equal(Number(deletedPlayerRows.rows[0].checkins), 0);
    await verificationClient.close();
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
