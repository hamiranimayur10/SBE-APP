'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drawSemiFinalPartners } = require('../public/tournament-draw');

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
