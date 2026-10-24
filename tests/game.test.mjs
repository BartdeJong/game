import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginGame,
  createMatch,
  heightLimit,
  resolveRound,
  towerPoints,
} from '../.test-build/src/game.js';
import {
  createRoomCode,
  formatRoomCode,
  normalizeRoomCode,
} from '../.test-build/src/room-code.js';

function player(id, overrides = {}) {
  return {
    id,
    name: id,
    score: 0,
    bankedTowers: 0,
    towers: [],
    connected: true,
    ...overrides,
  };
}

function activeState(players, dice) {
  return beginGame({ ...createMatch(players[0]), players }, dice);
}

function actions(...entries) {
  return new Map(entries);
}

test('uses the approved wind limits and triangular bank score', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(heightLimit), [12, 11, 10, 9, 8, 7, 6, 6]);
  assert.deepEqual([1, 2, 3, 4, 5].map(towerPoints), [1, 3, 6, 10, 15]);
});

test('topples a newly started tower when the round wind reaches its limit', () => {
  const state = activeState([player('a'), player('b')], [6, 6]);
  const result = resolveRound(state, actions(['a', { kind: 'new' }], ['b', { kind: 'new' }]));
  assert.ok(result.players.every((item) => item.towers.length === 0));
  assert.equal(result.history[0].toppled.length, 2);
});

test('applies a build before checking the wind', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 1 }] }),
    player('b'),
  ], [5, 6]);
  const result = resolveRound(state, actions(
    ['a', { kind: 'build', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  assert.deepEqual(result.players.find((item) => item.id === 'a').towers, []);
  assert.deepEqual(result.history[0].toppled.map((item) => item.height), [2]);
  assert.equal(result.players.find((item) => item.id === 'b').towers.length, 1);
});

test('banks before the wind and scores triangular points', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], [6, 6]);
  const result = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  assert.deepEqual(result.players.find((item) => item.id === 'a'), {
    id: 'a',
    name: 'a',
    score: 3,
    bankedTowers: 1,
    towers: [],
    connected: true,
  });
  assert.equal(result.history[0].banked[0].points, 3);
  assert.equal(result.history[0].toppled.length, 1);
});

test('ends after the round in which a third tower is banked', () => {
  const state = activeState([
    player('a', { score: 10, bankedTowers: 2, towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], [6, 6]);
  const result = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  assert.equal(result.status, 'finished');
  assert.equal(result.players.find((item) => item.id === 'a').score, 13);
  assert.deepEqual(result.winnerIds, ['a']);
  assert.equal(result.history[0].toppled.length, 1);
});

test('declares a shared tie for equal high scores', () => {
  const state = activeState([
    player('a', { score: 9, bankedTowers: 2, towers: [{ id: 'a1', height: 1 }] }),
    player('b', { score: 10, bankedTowers: 2, towers: [{ id: 'b1', height: 1 }] }),
  ], [2, 2]);
  const result = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  assert.deepEqual(result.winnerIds, ['a', 'b']);
});

test('rejects incomplete or illegal action sets without changing the original state', () => {
  const state = activeState([player('a'), player('b')], [3, 3]);
  assert.throws(() => resolveRound(state, actions(['a', { kind: 'new' }])), /Every player/);
  assert.throws(() => resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'missing' }],
    ['b', { kind: 'new' }],
  )), /Invalid action/);
  assert.deepEqual(state.players[0].towers, []);
});

test('creates short room codes with an easy-to-read display format', () => {
  const code = createRoomCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(formatRoomCode(code), `${code.slice(0, 4)}-${code.slice(4)}`);
});

test('normalizes room-code case and separators, and rejects invalid codes', () => {
  assert.equal(normalizeRoomCode('7k2m-q9rx'), '7K2MQ9RX');
  assert.equal(normalizeRoomCode('7K2M Q9RX'), '7K2MQ9RX');
  assert.throws(() => normalizeRoomCode('7K2M-Q9R'), /8-character room code/);
  assert.throws(() => normalizeRoomCode('7K2M-Q9R0'), /8-character room code/);
});
