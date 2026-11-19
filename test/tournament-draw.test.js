'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drawSemiFinalPartners, generateGroupPairings, groupRankedPlayers, scheduleMatchesForCourts } = require('../public/tournament-draw');

test('creates the requested number of distinct opponents for every player', () => {
  for (let size = 2; size <= 30; size++) {
    const players = Array.from({ length: size }, (_, index) => `Player ${index}`);
    for (let count = 1; count < size; count++) {
      if (size * count % 2) continue;
      const pairs = generateGroupPairings(players, count, () => 0);
      const opponents = new Map(players.map(player => [player, new Set()]));
      assert.equal(pairs.length, size * count / 2);
      pairs.forEach(([a, b]) => {
        assert.notEqual(a, b);
        assert.ok(!opponents.get(a).has(b));
        opponents.get(a).add(b);
        opponents.get(b).add(a);
      });
      players.forEach(player => assert.equal(opponents.get(player).size, count));
    }
  }
});

test('rejects impossible or invalid per-player match counts', () => {
  const players = Array.from({ length: 9 }, (_, index) => `Player ${index}`);
  assert.throws(() => generateGroupPairings(players, 3), /odd-sized group/);
  assert.throws(() => generateGroupPairings(players, 9), /less than/);
  assert.throws(() => generateGroupPairings(players, 0), /positive whole number/);
  assert.throws(() => generateGroupPairings(players, 2.5), /positive whole number/);
  assert.throws(() => generateGroupPairings(['Alice', ' alice '], 1), /distinct name/);
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
