import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginBuildingTurn,
  beginGame,
  beginNextRound,
  beginRematch,
  createMatch,
  createPlayerView,
  DEFAULT_WIN_POINTS,
  heightLimit,
  isLegalAction,
  returnToLobby,
  resolveRound,
  towerPoints,
  towerShield,
} from '../.test-build/src/game.js';
import { chooseBotBuildAction, chooseBotTurnChoice } from '../.test-build/src/bot.js';
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

function activeState(players, targetPoints = DEFAULT_WIN_POINTS) {
  return beginGame({ ...createMatch(players[0], targetPoints), players });
}

function buildAction(placements = []) {
  return { kind: 'build', placements };
}

function bankAction(towerId) {
  return { kind: 'bank', towerId };
}

function finishRound(state, actionsByPlayer, windDice, turnDice = {}) {
  let current = state;
  for (let turn = 0; turn < state.players.length; turn += 1) {
    if (current.status === 'resolution') current = beginNextRound(current);
    const activePlayer = current.players[current.currentPlayerIndex];
    const turnAction = actionsByPlayer[activePlayer.id] ?? buildAction();
    if (turnAction.kind === 'build' && current.turnMode === 'choose') {
      current = beginBuildingTurn(current, turnDice[activePlayer.id] ?? 6);
    }
    current = resolveRound(
      current,
      turnAction,
      turn === state.players.length - 1 ? windDice : null,
    );
  }
  return current;
}

test('uses approved base wind limits and triangular bank score', () => {
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

test('choosing bank does not roll a die; choosing build rolls before placement', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ]);
  assert.equal(state.turnMode, 'choose');
  assert.equal(state.turnDie, null);
  assert.equal(isLegalAction(state.players[0], bankAction('a1'), state.turnMode, state.turnDie), true);
  const afterBank = resolveRound(state, bankAction('a1'), null);
  assert.equal(afterBank.players[0].score, 3);
  assert.equal(afterBank.roundTurnRolls[0].die, null);
  assert.equal(afterBank.roundTurnRolls[0].choice, 'bank');
  assert.equal(afterBank.dice, null);

  const nextTurn = beginNextRound(afterBank);
  assert.equal(nextTurn.turnMode, 'choose');
  assert.equal(nextTurn.turnDie, null);
  const building = beginBuildingTurn(nextTurn, 5);
  assert.equal(building.turnMode, 'build');
  assert.equal(building.turnDie, 5);
  const result = resolveRound(building, buildAction([{ towerId: null, elements: 2 }]), [1, 2]);
  assert.deepEqual(result.history[0].turnRolls, [
    { playerId: 'a', choice: 'bank', die: null },
    { playerId: 'b', choice: 'build', die: 5 },
  ]);
});

test('builds can distribute one rolled die across multiple towers', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 1 }, { id: 'a2', height: 2 }] }),
    player('b'),
  ]);
  const allocation = buildAction([
    { towerId: 'a1', elements: 3 },
    { towerId: 'a2', elements: 2 },
    { towerId: null, elements: 1 },
  ]);
  assert.equal(isLegalAction(state.players[0], allocation, 'choose', null), false);
  const building = beginBuildingTurn(state, 6);
  assert.equal(isLegalAction(state.players[0], allocation, building.turnMode, building.turnDie), true);
  const result = finishRound(building, { a: allocation }, [1, 1], { b: 1 });
  assert.deepEqual(result.players[0].towers.map((tower) => tower.height), [4, 4, 1]);
  assert.equal(result.history[0].actions[0].description, 'added 6 floors');
});

test('limits standing towers to seven', () => {
  const sixTowers = Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, height: 1 }));
  const building = beginBuildingTurn(activeState([
    player('a', { towers: sixTowers }),
    player('b'),
  ]), 3);
  assert.equal(isLegalAction(building.players[0], buildAction([
    { towerId: null, elements: 1 },
  ]), building.turnMode, building.turnDie), true);
  assert.equal(isLegalAction(building.players[0], buildAction([
    { towerId: null, elements: 1 },
    { towerId: null, elements: 1 },
  ]), building.turnMode, building.turnDie), false);

  const sevenTowers = [...sixTowers, { id: 'a6', height: 1 }];
  const full = beginBuildingTurn(activeState([
    player('a', { towers: sevenTowers }),
    player('b'),
  ]), 3);
  assert.equal(isLegalAction(full.players[0], buildAction([
    { towerId: null, elements: 1 },
  ]), full.turnMode, full.turnDie), false);
  assert.equal(isLegalAction(full.players[0], buildAction([
    { towerId: 'a0', elements: 1 },
  ]), full.turnMode, full.turnDie), true);
});

test('builds a new tower in its selected slot and retains that slot', () => {
  const state = activeState([player('a'), player('b')]);
  const firstTurn = resolveRound(beginBuildingTurn(state, 3), buildAction([
    { towerId: null, elements: 3, slot: 5 },
  ]), null);
  assert.equal(firstTurn.players[0].towers[0].slot, 5);
  assert.equal(firstTurn.players[0].towers[0].height, 3);

  const nextTurn = beginBuildingTurn(beginNextRound(firstTurn), 1);
  const result = resolveRound(nextTurn, buildAction(), [1, 1]);
  assert.equal(result.players[0].towers[0].slot, 5);
  assert.equal(isLegalAction(state.players[0], buildAction([
    { towerId: null, elements: 1, slot: 7 },
  ]), 'build', 1), false);
  assert.equal(isLegalAction(state.players[0], buildAction([
    { towerId: null, elements: 1, slot: 5 },
    { towerId: null, elements: 1, slot: 5 },
  ]), 'build', 2), false);
  assert.equal(isLegalAction(state.players[0], buildAction([
    { towerId: null, elements: 1, slot: 1 },
    { towerId: null, elements: 1, slot: 2 },
  ]), 'build', 2), false);
});

test('wind rolls only after every player has chosen and applies once to all towers', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 7 }] }),
    player('b', { towers: [{ id: 'b1', height: 7 }] }),
  ]);
  const firstTurn = resolveRound(state, bankAction('a1'), null);
  assert.equal(firstTurn.dice, null);
  assert.equal(firstTurn.history.length, 0);
  const nextTurn = beginNextRound(firstTurn);
  const building = beginBuildingTurn(nextTurn, 2);
  const result = resolveRound(building, buildAction(), [3, 3]);
  assert.deepEqual(result.history[0].dice, [3, 3]);
  assert.deepEqual(result.history[0].fallenCounts, { a: 0, b: 1 });
  assert.equal(result.history[0].toppled[0].playerId, 'b');
});

test('more towers grant capped wind protection to every standing tower', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 8].map(towerShield), [0, 0, 1, 2, 3, 3]);
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 7 }, { id: 'a2', height: 7 }, { id: 'a3', height: 7 }] }),
    player('b'),
  ]);
  const result = finishRound(state, {}, [3, 3]);
  assert.equal(result.history[0].fallenCounts.a, 0);
  assert.equal(result.history[0].toppled.length, 0);
});

test('banking is exclusive, scores the selected tower, and protects it from wind', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }, { id: 'a2', height: 1 }] }),
    player('b'),
  ]);
  assert.equal(isLegalAction(state.players[0], bankAction('a1'), 'choose', null), true);
  const result = finishRound(state, { a: bankAction('a1') }, [6, 6]);
  assert.equal(result.players[0].score, 3);
  assert.equal(result.players[0].bankedTowers, 1);
  assert.deepEqual(result.history[0].banked[0], { playerId: 'a', towerHeight: 2, points: 3 });
  assert.equal(result.history[0].turnRolls[0].die, null);
});

test('checks the win target only after the shared wind resolves', () => {
  const state = activeState([
    player('a', { score: 10, towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], 13);
  const firstTurn = resolveRound(state, bankAction('a1'), null);
  assert.equal(firstTurn.status, 'resolution');
  assert.equal(firstTurn.players[0].score, 13);
  assert.equal(firstTurn.winnerIds.length, 0);
  const nextTurn = beginNextRound(firstTurn);
  const result = resolveRound(beginBuildingTurn(nextTurn, 2), buildAction(), [1, 1]);
  assert.equal(result.status, 'finished');
  assert.equal(result.players[0].roomWins, 1);
  assert.deepEqual(result.winnerIds, ['a']);
});

test('rematches and the room lobby keep cumulative wins and target settings', () => {
  const state = activeState([
    player('a', { score: 7, towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ], 10);
  const finished = finishRound(state, { a: bankAction('a1') }, [2, 2]);
  const rematch = beginRematch(finished);
  assert.equal(rematch.status, 'choice');
  assert.equal(rematch.round, 1);
  assert.equal(rematch.turnMode, 'choose');
  assert.equal(rematch.turnDie, null);
  assert.equal(rematch.targetPoints, 10);
  assert.equal(rematch.players[0].score, 0);
  assert.equal(rematch.players[0].roomWins, 1);

  const lobby = returnToLobby(finished);
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.turnDie, null);
  assert.equal(lobby.turnMode, null);
  assert.equal(lobby.targetPoints, 10);
  assert.equal(lobby.players[0].roomWins, 1);
});

test('rejects early die rolls, invalid allocations, and invalid wind', () => {
  const state = activeState([player('a'), player('b')]);
  const earlyBuild = buildAction([{ towerId: null, elements: 1 }]);
  assert.equal(isLegalAction(state.players[0], earlyBuild, state.turnMode, state.turnDie), false);
  assert.throws(() => beginBuildingTurn(state, 7), /1 to 6/);
  const building = beginBuildingTurn(state, 3);
  assert.equal(isLegalAction(state.players[0], buildAction([{ towerId: null, elements: 4 }]), 'build', 3), false);
  assert.equal(isLegalAction(state.players[0], buildAction([{ towerId: 'missing', elements: 1 }]), 'build', 3), false);
  const afterFirstTurn = resolveRound(building, buildAction([{ towerId: null, elements: 1 }]), null);
  const finalTurn = beginBuildingTurn(beginNextRound(afterFirstTurn), 3);
  assert.throws(() => resolveRound(finalTurn, buildAction(), [1, 7]), /1 to 6/);
});

test('creates and normalizes short room codes', () => {
  const code = createRoomCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(formatRoomCode(code), `${code.slice(0, 4)}-${code.slice(4)}`);
  assert.equal(normalizeRoomCode('7k2m-q9rx'), '7K2MQ9RX');
  assert.equal(normalizeRoomCode('7K2M Q9RX'), '7K2MQ9RX');
  assert.throws(() => normalizeRoomCode('7K2M-Q9R'), /8-character room code/);
});

test('robots choose banking before rolling or choose building and allocate the rolled die', () => {
  assert.deepEqual(chooseBotTurnChoice(player('robot'), 80), { kind: 'build' });
  assert.deepEqual(chooseBotBuildAction(player('robot'), 4), {
    kind: 'build',
    placements: [{ towerId: null, elements: 4, slot: 0 }],
  });
  const readyToWin = player('robot', { score: 7, towers: [{ id: 't1', height: 2 }] });
  assert.deepEqual(chooseBotTurnChoice(readyToWin, 10), { kind: 'bank', towerId: 't1' });
});

test('player views hide opponents towers but preserve public wind-topple data', () => {
  const state = activeState([
    player('a'),
    player('b', { towers: [{ id: 'b1', height: 7 }] }),
  ]);
  const firstTurn = resolveRound(beginBuildingTurn(state, 1), buildAction([{ towerId: null, elements: 1 }]), null);
  const nextTurn = beginNextRound(firstTurn);
  const result = resolveRound(beginBuildingTurn(nextTurn, 1), buildAction(), [6, 6]);
  const view = createPlayerView(result, 'a');
  assert.deepEqual(view.players.find((item) => item.id === 'b').towers, []);
  assert.deepEqual(view.history[0].toppled.map((item) => item.playerId), ['a', 'b']);
  assert.deepEqual(view.history[0].fallenCounts, { a: 1, b: 1 });
});
