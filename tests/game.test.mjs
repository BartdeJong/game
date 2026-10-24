import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginGame,
  beginRematch,
  createPlayerView,
  createMatch,
  DEFAULT_WIN_POINTS,
  heightLimit,
  returnToLobby,
  resolveRound,
  towerPoints,
} from '../.test-build/src/game.js';
import { chooseBotAction } from '../.test-build/src/bot.js';
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
    roomWins: 0,
    towers: [],
    connected: true,
    ...overrides,
  };
}

function activeState(players, dice, targetPoints = DEFAULT_WIN_POINTS) {
  return beginGame({ ...createMatch(players[0], targetPoints), players }, dice);
}

function actions(...entries) {
  return new Map(entries);
}

test('uses the approved wind limits and triangular bank score', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(heightLimit), [12, 11, 10, 9, 8, 7, 6, 6]);
  assert.deepEqual([1, 2, 3, 4, 5].map(towerPoints), [1, 3, 6, 10, 15]);
});

test('defaults the room win target to 80 and validates configured targets', () => {
  assert.equal(createMatch(player('host')).targetPoints, 80);
  assert.equal(createMatch(player('host'), 10).targetPoints, 10);
  assert.equal(createMatch(player('host'), 200).targetPoints, 200);
  assert.throws(() => createMatch(player('host'), 9), /10 to 200/);
  assert.throws(() => createMatch(player('host'), 80.5), /whole number/);
});

test('topples a newly started tower when the round wind reaches its limit', () => {
  const state = activeState([player('a'), player('b')], [6, 6]);
  const result = resolveRound(state, actions(['a', { kind: 'new' }], ['b', { kind: 'new' }]));
  assert.ok(result.players.every((item) => item.towers.length === 0));
  assert.equal(result.history[0].toppled.length, 2);
  assert.deepEqual(result.history[0].fallenCounts, { a: 1, b: 1 });
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
    roomWins: 0,
    towers: [],
    connected: true,
  });
  assert.equal(result.history[0].banked[0].points, 3);
  assert.equal(result.history[0].toppled.length, 1);
});

test('ends when a player reaches the configured points target and records the winner', () => {
  const state = activeState([
    player('a', { score: 10, towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], [6, 6], 13);
  const result = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  assert.equal(result.status, 'finished');
  assert.equal(result.players.find((item) => item.id === 'a').score, 13);
  assert.equal(result.players.find((item) => item.id === 'a').roomWins, 1);
  assert.deepEqual(result.winnerIds, ['a']);
  assert.equal(result.history[0].toppled.length, 1);
});

test('a third bank alone does not end a game before the target', () => {
  const state = activeState([
    player('a', { bankedTowers: 2, towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], [2, 2]);
  const result = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  assert.equal(result.status, 'resolution');
  assert.equal(result.players.find((item) => item.id === 'a').bankedTowers, 3);
  assert.equal(result.players.find((item) => item.id === 'a').roomWins, 0);
});

test('declares a shared target tie and awards each winner one room win', () => {
  const state = activeState([
    player('a', { score: 9, towers: [{ id: 'a1', height: 1 }] }),
    player('b', { score: 9, towers: [{ id: 'b1', height: 1 }] }),
  ], [2, 2], 10);
  const result = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'bank', towerId: 'b1' }],
  ));
  assert.deepEqual(result.winnerIds, ['a', 'b']);
  assert.deepEqual(result.players.map((item) => item.roomWins), [1, 1]);
});

test('rematches and the room lobby keep cumulative wins and the configured target', () => {
  const state = activeState([
    player('a', { score: 7, towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], [2, 2], 10);
  const finished = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'new' }],
  ));
  const rematch = beginRematch(finished, [3, 4]);
  assert.equal(rematch.status, 'choice');
  assert.equal(rematch.round, 1);
  assert.equal(rematch.targetPoints, 10);
  assert.equal(rematch.players.find((item) => item.id === 'a').score, 0);
  assert.equal(rematch.players.find((item) => item.id === 'a').roomWins, 1);
  assert.equal(rematch.players.find((item) => item.id === 'b').roomWins, 0);

  const lobby = returnToLobby(finished);
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.targetPoints, 10);
  assert.equal(lobby.players.find((item) => item.id === 'a').roomWins, 1);
  assert.equal(lobby.players.find((item) => item.id === 'a').score, 0);
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

test('robot starts, builds safely, banks threatened towers, and secures a third bank', () => {
  const bot = player('robot', { isBot: true });
  assert.deepEqual(chooseBotAction(bot, 7), { kind: 'new' });

  const withTower = player('robot', { isBot: true, towers: [{ id: 't1', height: 2 }] });
  assert.deepEqual(chooseBotAction(withTower, 7), { kind: 'build', towerId: 't1' });
  assert.deepEqual(chooseBotAction(withTower, 11), { kind: 'bank', towerId: 't1' });

  const nearEnd = player('robot', {
    isBot: true,
    bankedTowers: 2,
    towers: [{ id: 't1', height: 2 }, { id: 't2', height: 4 }],
  });
  assert.deepEqual(chooseBotAction(nearEnd, 5), { kind: 'bank', towerId: 't2' });
});

test('player views hide opponents towers and detailed round actions but retain fall counts and scores', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 1 }] }),
    player('b', { towers: [{ id: 'b1', height: 1 }] }),
  ], [6, 6]);
  const choiceView = createPlayerView(state, 'a');
  assert.deepEqual(choiceView.players.find((item) => item.id === 'a').towers, [{ id: 'a1', height: 1 }]);
  assert.deepEqual(choiceView.players.find((item) => item.id === 'b').towers, []);
  const resolved = resolveRound(state, actions(
    ['a', { kind: 'bank', towerId: 'a1' }],
    ['b', { kind: 'build', towerId: 'b1' }],
  ));
  const view = createPlayerView(resolved, 'a');

  assert.deepEqual(view.players.map((item) => item.score), [1, 0]);
  assert.deepEqual(view.players.find((item) => item.id === 'b').towers, []);
  assert.deepEqual(view.history[0].actions.map((item) => item.playerId), ['a']);
  assert.deepEqual(view.history[0].banked.map((item) => item.playerId), ['a']);
  assert.deepEqual(view.history[0].toppled, []);
  assert.deepEqual(view.history[0].fallenCounts, { a: 0, b: 1 });
});
