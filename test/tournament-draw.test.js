'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drawSemiFinalPartners, generateGroupPairings, generateGroupSchedule, groupRankedPlayers, isTournamentReadyToComplete, scheduleMatchesForCourts } = require('../public/tournament-draw');

test('completion requires every stage and every group final to be finished', () => {
  const done = () => ({ completed: true });
  const tournament = {
    phase: 'finals',
    qr1Matches: [done()],
    qr2Pools: { A: ['A'], B: ['B'] },
    qr2Matches: { A: [done()], B: [done()] },
    semis: { A: [done(), done()], B: [done(), done()] },
    finals: { A: done(), B: done() }
  };
  assert.equal(isTournamentReadyToComplete(tournament), true);
  tournament.finals.B.completed = false;
  assert.equal(isTournamentReadyToComplete(tournament), false);
  tournament.finals.B.completed = true;
  tournament.qr1Matches[0].completed = false;
  assert.equal(isTournamentReadyToComplete(tournament), false);
  tournament.qr1Matches[0].completed = true;
  tournament.qr2Matches.B = [];
  assert.equal(isTournamentReadyToComplete(tournament), false);
  tournament.qr2Matches.B = [done()];
  tournament.semis.B = [done()];
  assert.equal(isTournamentReadyToComplete(tournament), false);
  tournament.semis.B.push(done());
  tournament.semis.C = [{ completed: false }];
  assert.equal(isTournamentReadyToComplete(tournament), false);
  delete tournament.semis.C;
  tournament.phase = 'completed';
  assert.equal(isTournamentReadyToComplete(tournament), false);
});

test('generated qualifying schedules give every player exactly the requested matches', () => {
  for (const size of [4, 5, 6, 8, 9, 10, 15, 30]) {
    const players = Array.from({ length: size }, (_, index) => `Player ${index}`);
    for (const count of [1, 2, 3, 4, 5, 8]) {
      if (count >= size || size * count % 4) continue;
      const schedule = generateGroupSchedule(players, count, 'A', 'QR1');
      const counts = Object.fromEntries(players.map(player => [player, 0]));
      const rounds = new Map();
      const partnerships = new Set();
      assert.equal(schedule.length, size * count / 4);
      for (const match of schedule) {
        const team1 = match.p1.split(' & ');
        const team2 = match.p2.split(' & ');
        assert.equal(team1.length, 2);
        assert.equal(team2.length, 2);
        for (const team of [team1, team2]) {
          const key = [...team].sort().join('|');
          assert.ok(!partnerships.has(key), `Repeated partnership in ${size}-player group`);
          partnerships.add(key);
        }
        const matchPlayers = [...team1, ...team2];
        assert.equal(new Set(matchPlayers).size, 4);
        matchPlayers.forEach(player => counts[player]++);
        const participants = rounds.get(match.round) || [];
        participants.push(...matchPlayers);
        rounds.set(match.round, participants);
      }
      assert.deepEqual(Object.values(counts), players.map(() => count));
      for (const participants of rounds.values()) {
        assert.ok(participants.length <= 8);
        assert.equal(new Set(participants).size, participants.length);
      }
    }
  }
});

test('representative group sizes can draw feasible unique partnerships', () => {
  for (const size of [4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 24, 30, 40, 80]) {
    const players = Array.from({ length: size }, (_, index) => `Player ${index}`);
    for (let count = 1; count < size; count++) {
      if (size * count % 4) continue;
      const matches = generateGroupPairings(players, count, () => 0);
      const partners = new Map(players.map(player => [player, new Set()]));
      assert.equal(matches.length, size * count / 4);
      matches.forEach(match => {
        assert.equal(new Set(match.flat()).size, 4);
        match.forEach(([a, b]) => {
          assert.ok(!partners.get(a).has(b), `${a} and ${b} paired twice for ${size}/${count}`);
          partners.get(a).add(b);
          partners.get(b).add(a);
        });
      });
      players.forEach(player => assert.equal(partners.get(player).size, count));
    }
  }
});

test('rejects impossible or invalid per-player match counts', () => {
  const players = Array.from({ length: 9 }, (_, index) => `Player ${index}`);
  assert.throws(() => generateGroupPairings(players, 3), /divisible by 4/);
  assert.throws(() => generateGroupPairings(['A', 'B', 'C', 'D'], 4), /less than the group size/);
  assert.throws(() => generateGroupPairings(players, 12), /less than the group size/);
  assert.throws(() => generateGroupPairings(['A', 'B', 'C'], 4), /at least 4/);
  assert.throws(() => generateGroupPairings(players, 0), /positive whole number/);
  assert.throws(() => generateGroupPairings(players, 2.5), /positive whole number/);
  assert.throws(() => generateGroupPairings(['Alice', ' alice ', 'C', 'D'], 1), /distinct name/);
  assert.throws(() => generateGroupPairings(['A & B', 'C', 'D', 'E'], 1), /cannot contain/);
});

test('splits ranked players into consecutive, balanced groups', () => {
  const groups = groupRankedPlayers(Array.from({ length: 11 }, (_, index) => index + 1), 3);

  assert.deepEqual(groups, {
    A: [1, 2, 3, 4],
    B: [5, 6, 7, 8],
    C: [9, 10, 11]
  });
  assert.throws(() => groupRankedPlayers(['Only player'], 2), RangeError);
});

test('schedules up to two concurrent matches without shared players', () => {
  const matches = [
    { id: 'one', p1: 'A', p2: 'B' },
    { id: 'two', p1: 'B', p2: 'C' },
    { id: 'three', p1: 'C', p2: 'D' },
    { id: 'four', p1: 'A', p2: 'D' },
    { id: 'five', p1: 'E', p2: 'F' }
  ];
  const schedule = scheduleMatchesForCourts(matches);
  const rounds = new Map();

  schedule.forEach(match => {
    const round = rounds.get(match.round) || [];
    round.push(match);
    rounds.set(match.round, round);
  });
  assert.deepEqual(schedule.map(match => match.id).sort(), matches.map(match => match.id).sort());
  for (const round of rounds.values()) {
    assert.ok(round.length <= 2);
    const participants = round.flatMap(match => [match.p1, match.p2]);
    assert.equal(new Set(participants).size, participants.length);
  }
});

test('court scheduling treats doubles partners as individual participants', () => {
  const schedule = scheduleMatchesForCourts([
    { id: 'doubles-one', t1: 'A & B', t2: 'C & D' },
    { id: 'doubles-two', t1: 'D & E', t2: 'F & G' },
    { id: 'doubles-three', t1: 'H & I', t2: 'J & K' }
  ]);
  const firstRound = schedule.filter(match => match.round === 1);

  assert.deepEqual(firstRound.map(match => match.id), ['doubles-one', 'doubles-three']);
  assert.deepEqual(firstRound.map(match => match.court), [1, 2]);
});

test('finds a non-overlapping court pair even when the first match blocks it', () => {
  const schedule = scheduleMatchesForCourts([
    { id: 'ab', p1: 'A', p2: 'B' },
    { id: 'ac', p1: 'A', p2: 'C' },
    { id: 'bd', p1: 'B', p2: 'D' }
  ]);
  const firstRound = schedule.filter(match => match.round === 1);

  assert.deepEqual(firstRound.map(match => match.id), ['ac', 'bd']);
  assert.deepEqual(firstRound.map(match => match.court), [1, 2]);
});

test('randomly pairs each top-four player with one distinct bottom-four player', () => {
  const players = ['Top 1', 'Top 2', 'Top 3', 'Top 4', 'Bottom 1', 'Bottom 2', 'Bottom 3', 'Bottom 4'];
  const draw = drawSemiFinalPartners(players, () => 0);

  assert.deepEqual(draw, [
    ['Top 1', 'Bottom 2'],
    ['Top 2', 'Bottom 3'],
    ['Top 3', 'Bottom 4'],
    ['Top 4', 'Bottom 1']
  ]);
  assert.deepEqual(draw.map(team => team[0]), players.slice(0, 4));
  assert.deepEqual(draw.map(team => team[1]).sort(), players.slice(4).sort());
  assert.deepEqual(players, ['Top 1', 'Top 2', 'Top 3', 'Top 4', 'Bottom 1', 'Bottom 2', 'Bottom 3', 'Bottom 4']);
});

test('rejects draws with fewer or more than eight qualifiers', () => {
  assert.throws(() => drawSemiFinalPartners(['Top 1', 'Top 2']), RangeError);
  assert.throws(() => drawSemiFinalPartners(Array.from({ length: 9 }, (_, index) => `Player ${index + 1}`)), RangeError);
});
