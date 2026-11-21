'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accumulateStandings, buildAnalytics, computeStandings, getBadges, getProfileSkillLevel } = require('../public/player-analytics');

test('profile skill levels use the 1–10 scale and respect visibility', () => {
  for (const [skill, label] of [[1, 'Beginner'], [2, 'Beginner'], [3, 'Beginner'], [4, 'Beginner'], [5, 'Beginner'], [6, 'Intermediate'], [7, 'Intermediate'], [8, 'Advanced'], [9, 'Advanced'], [10, 'Advanced']]) {
    assert.deepEqual(getProfileSkillLevel({ skill }), { skill, label });
  }
  for (const skill of [null, undefined, 0, 11, 3.5, '7']) {
    assert.equal(getProfileSkillLevel({ skill }), null);
  }
  const hidden = { skill: 8, visibility: { skill: false } };
  assert.equal(getProfileSkillLevel(hidden), null);
  assert.deepEqual(getProfileSkillLevel(hidden, true), { skill: 8, label: 'Advanced' });
});

test('overall round 1 standings rank WP first without changing configured qualification order', () => {
  const players = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const matches = [
    { p1: 'A & B', p2: 'E & F', s1: 21, s2: 19, completed: true },
    { p1: 'A & B', p2: 'E & F', s1: 21, s2: 19, completed: true },
    { p1: 'C & D', p2: 'G & H', s1: 21, s2: 0, completed: true }
  ];
  const ranking = { winPointsWeight: 1, winMarginWeight: 1, lossMarginWeight: 1, tiebreakers: ['wins', 'wp', 'pf', 'pa'] };
  const overall = computeStandings(players, matches, ranking, true);
  const qualification = computeStandings(players, matches, ranking);
  assert.deepEqual(overall.slice(0, 4).map(row => row.player), ['C', 'D', 'A', 'B']);
  assert.deepEqual(overall.slice(0, 4).map(row => row.wp), [22, 22, 6, 6]);
  assert.deepEqual(qualification.slice(0, 4).map(row => row.player), ['A', 'B', 'C', 'D']);
  assert.ok(overall[0].tiedFlag);
});

test('qualifying doubles credit both players on each side and preserve legacy singles', () => {
  const players = ['Alex', 'Blair', 'Casey', 'Drew'];
  const matches = [
    { p1: 'Alex & Blair', p2: 'Casey & Drew', s1: 21, s2: 15, completed: true },
    { p1: 'Casey', p2: 'Alex', s1: 21, s2: 19, completed: true },
    { p1: 'Alex & Alex', p2: 'Casey & Drew', s1: 21, s2: 10, completed: true }
  ];
  const rows = Object.fromEntries(accumulateStandings(players, matches).map(row => [row.player, row]));
  assert.deepEqual([rows.Alex.played, rows.Alex.wins, rows.Alex.losses, rows.Alex.pf, rows.Alex.pa, rows.Alex.winMargins, rows.Alex.lossMargins], [2, 1, 1, 40, 36, 6, 2]);
  assert.deepEqual([rows.Blair.played, rows.Blair.wins, rows.Blair.pf, rows.Blair.pa], [1, 1, 21, 15]);
  assert.deepEqual([rows.Casey.played, rows.Casey.wins, rows.Casey.losses, rows.Casey.pf, rows.Casey.pa], [2, 1, 1, 36, 40]);
  assert.deepEqual([rows.Drew.played, rows.Drew.losses, rows.Drew.pf, rows.Drew.pa], [1, 1, 15, 21]);

  const tournament = { tournamentId: 'doubles', config: { name: 'Doubles' }, groups: [{ players }], qr1Matches: [matches[0]], qr2Matches: {} };
  const analytics = buildAnalytics([tournament], [], 'doubles');
  for (const player of players) {
    const result = analytics.getPlayer(player);
    const won = player === 'Alex' || player === 'Blair';
    assert.deepEqual([result.matchesPlayed, result.wins, result.losses, result.pointsFor, result.pointsAgainst, result.rankingPointsEarned],
      won ? [1, 1, 0, 21, 15, 26] : [1, 0, 1, 15, 21, -6]);
  }
});

function makeTournament() {
  const matches = [
    { id: '1', p1: 'Alex', p2: 'Blair', s1: 21, s2: 15, completed: true, completedAt: '2026-01-01T10:00:00Z' },
    { id: '2', p1: 'Alex', p2: 'Blair', s1: 21, s2: 19, completed: true, completedAt: '2026-01-02T10:00:00Z' },
    { id: '3', p1: 'Blair', p2: 'Alex', s1: 21, s2: 18, completed: true, completedAt: '2026-01-03T10:00:00Z' },
    { id: '4', p1: 'Alex', p2: 'Casey', s1: 21, s2: 12, completed: true, completedAt: '2026-01-04T10:00:00Z' },
    { id: '5', p1: 'Alex', p2: 'Casey', s1: 21, s2: 20, completed: true, completedAt: '2026-01-05T10:00:00Z' },
    { id: 'pending', p1: 'Alex', p2: 'Blair', s1: null, s2: null, completed: false }
  ];
  return {
    tournamentId: 'winter-open',
    config: { name: 'Winter Open', date: '2026-01-01', pointsToWin: 21, deuceCap: 30 },
    groups: [{ id: 'A', players: ['Alex', 'Blair', 'Casey'] }],
    qr1Matches: matches,
    qr2Matches: {},
    semis: {
      A: [
        { id: 'semi-1', t1: 'Alex & Drew', t2: 'Blair & Casey', s1: 21, s2: 16, completed: true, completedAt: '2026-01-06T10:00:00Z' }
      ]
    },
    finals: {
      A: {
        id: 'final-a',
        t1: 'Alex & Drew',
        t2: 'Casey & Blair',
        games: [{ s1: 21, s2: 17 }, { s1: 21, s2: 19 }],
        completed: true,
        winner: 'Alex & Drew',
        completedAt: '2026-01-07T10:00:00Z'
      }
    }
  };
}

test('computes match record, recent form, ranking points, and winning streak', () => {
  const analytics = buildAnalytics([makeTournament()], [], 'winter-open');
  const alex = analytics.getPlayer('alex');

  assert.equal(alex.matchesPlayed, 7);
  assert.equal(alex.wins, 6);
  assert.equal(alex.losses, 1);
  assert.equal(alex.winPercentage, 6 / 7 * 100);
  assert.equal(alex.form, 'L-W-W-W-W');
  assert.equal(alex.formRating, 80);
  assert.equal(alex.longestWinningStreak, 4);
  assert.equal(alex.titlesWon, 1);
  assert.equal(alex.finalsReached, 1);
  assert.equal(analytics.getTournamentRank('Alex', 'winter-open'), 1);
  assert.deepEqual(
    analytics.records.find(record => record.stage === 'finals').gameScores,
    [{ s1: 21, s2: 17 }, { s1: 21, s2: 19 }]
  );
});

test('computes head-to-head and doubles partnership results', () => {
  const analytics = buildAnalytics([makeTournament()], [], 'winter-open');
  const headToHead = analytics.getHeadToHead('Alex', 'Blair');
  const partnership = analytics.getPartnerships('Alex').find(item => item.partnerName === 'Drew');

  assert.equal(headToHead.totalMeetings, 5);
  assert.equal(headToHead.wins, 4);
  assert.equal(headToHead.losses, 1);
  assert.equal(headToHead.currentWinStreak, 2);
  assert.equal(partnership.matchesPlayedTogether, 2);
  assert.equal(partnership.winsTogether, 2);
  assert.equal(partnership.titlesTogether, 1);
  assert.equal(partnership.bestTournamentFinish, 'Champion');
  assert.equal(partnership.averagePointsPerMatch, 31.5);
});

test('ignores incomplete matches and does not award unsupported triple-crown badges', () => {
  const analytics = buildAnalytics([makeTournament()], [{ name: 'Rookie' }], 'winter-open');
  const rookie = analytics.getPlayer('Rookie');

  assert.equal(rookie.matchesPlayed, 0);
  assert.equal(rookie.winPercentage, 0);
  assert.equal(rookie.performanceIndex, 10);
  assert.ok(getBadges(analytics.getPlayer('Alex')).every(badge => badge.id !== 'triple-crown'));
});

test('awards undefeated tournament badges only after a title-winning final', () => {
  const tournament = {
    tournamentId: 'club-night',
    config: { name: 'Club Night' },
    groups: [{ id: 'A', players: ['Taylor', 'Jordan'] }],
    qr1Matches: [
      { id: 'group-1', p1: 'Taylor', p2: 'Jordan', s1: 21, s2: 12, completed: true }
    ],
    finals: {}
  };
  let analytics = buildAnalytics([tournament], [], 'club-night');
  assert.ok(getBadges(analytics.getPlayer('Taylor')).every(badge => badge.id !== 'undefeated'));

  tournament.finals.A = {
    id: 'final-a',
    t1: 'Taylor',
    t2: 'Jordan',
    games: [{ s1: 21, s2: 14 }],
    completed: true,
    winner: 'Taylor'
  };
  analytics = buildAnalytics([tournament], [], 'club-night');
  assert.ok(getBadges(analytics.getPlayer('Taylor')).some(badge => badge.id === 'undefeated'));
});

test('links roster names and completed scores to a stable player profile ID', () => {
  const playerId = 'c0d0e5e0-8ca6-45f1-b7b1-10b4bc9fc8cc';
  const tournament = {
    tournamentId: 'profile-link-test',
    config: { name: 'Profile Link Test' },
    playerProfileIds: { 'alex chen': playerId },
    groups: [{ id: 'A', players: ['Alex Chen', 'Blair'] }],
    qr1Matches: [
      { id: '1', p1: 'Alex Chen', p2: 'Blair', s1: 21, s2: 12, completed: true }
    ]
  };
  const profiles = [{ playerId, name: 'Alexandra Chen', aliases: ['Alex Chen', 'Alex'] }];

  let analytics = buildAnalytics([tournament], profiles, 'profile-link-test');
  let player = analytics.getPlayer('Alex');
  assert.equal(player.playerId, playerId);
  assert.equal(player.matchesPlayed, 1);
  assert.equal(analytics.records[0].side1PlayerIds[0], playerId);

  tournament.qr1Matches.push({
    id: '2', p1: 'Alexandra Chen', p2: 'Blair', s1: 15, s2: 21, completed: true
  });
  analytics = buildAnalytics([tournament], profiles, 'profile-link-test');
  player = analytics.getPlayer('Alex Chen');
  assert.equal(player.playerId, playerId);
  assert.equal(player.matchesPlayed, 2);
  assert.equal(player.wins, 1);
  assert.equal(player.losses, 1);
  assert.deepEqual(analytics.records.map(record => record.side1PlayerIds[0]), [playerId, playerId]);
});
