import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginGame,
  createMatch,
  heightLimit,
  resolveRound,
  towerPoints,
} from '../.test-build/src/game.js';
import { decodeSignal, encodeSignal } from '../.test-build/src/signaling.js';

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

test('round-trips compressed offer and answer codes, including pasted line breaks', () => {
  for (const type of ['offer', 'answer']) {
    const signal = { type, sdp: `v=0\r\no=- ${type} session\r\ns=-\r\n` };
    const code = encodeSignal(signal);
    assert.ok(code.startsWith('SKY1:'));
    assert.deepEqual(decodeSignal(code), signal);
    assert.deepEqual(decodeSignal(`${code.slice(0, 12)}\n${code.slice(12)}`), signal);
  }
});

test('rejects connection codes that are not Skyline codes or have an invalid payload', () => {
  assert.throws(() => decodeSignal('not-a-code'), /not a Skyline connection code/);
  assert.throws(() => decodeSignal('SKY1:invalid'), /invalid|incomplete/i);
});
