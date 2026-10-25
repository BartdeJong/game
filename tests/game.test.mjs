import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginBankingTurn,
  beginBuildingTurn,
  beginGame,
  beginNextRound,
  beginRematch,
  createMatch,
  createPlayerView,
  DEFAULT_WIN_POINTS,
  heightLimit,
  isLegalAction,
  MAX_PLAYERS,
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
import { LANGUAGES, localizeText } from '../.test-build/src/i18n.js';
import { parseMessage } from '../.test-build/src/protocol.js';

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
  const actions = [];
  for (const activePlayer of state.players) {
    const turnAction = actionsByPlayer[activePlayer.id] ?? buildAction();
    if (!current.roundTurnRolls.some((turn) => turn.playerId === activePlayer.id)) {
      current = turnAction.kind === 'build'
        ? beginBuildingTurn(current, activePlayer.id, turnDice[activePlayer.id] ?? 6)
        : beginBankingTurn(current, activePlayer.id);
    }
    actions.push({ playerId: activePlayer.id, action: turnAction });
  }
  return resolveRound(current, actions, windDice);
}

test('localizes interface text in the supported languages and preserves English', () => {
  assert.deepEqual(LANGUAGES.map((language) => language.code), ['en', 'nl', 'fy', 'de', 'fr', 'es', 'da']);
  assert.equal(localizeText('Host a game', 'en'), 'Host a game');
  assert.equal(localizeText('Host a game', 'nl'), 'Start een spel');
  assert.equal(localizeText('Host a game', 'fy'), 'Begjin in spul');
  assert.equal(localizeText('Host a game', 'de'), 'Spiel hosten');
  assert.equal(localizeText('Host a game', 'fr'), 'Héberger une partie');
  assert.equal(localizeText('Host a game', 'es'), 'Crear partida');
  assert.equal(localizeText('Host a game', 'da'), 'Vær vært for et spil');
  assert.equal(localizeText('ROUND 3 · PARALLEL TURNS', 'fr'), 'MANCHE 3 · TOURS SIMULTANÉS');
  assert.equal(localizeText('Tower, height 4, worth 10 points', 'nl'), 'Toren, hoogte 4, waarde 10 punten');
  assert.equal(localizeText('Shared wind: 2 plus 5 equals 7', 'es'), 'Viento compartido: 2 más 5 es 7');
  assert.equal(localizeText('e.g. Alex', 'fr'), 'ex. Alex');
  assert.equal(localizeText('e.g. 7K2M-Q9RX', 'da'), 'fx 7K2M-Q9RX');
  assert.equal(localizeText('Every player must choose and submit one action before the shared wind is rolled.', 'de'), 'Alle Spieler müssen eine Aktion wählen und abgeben, bevor der gemeinsame Wind gewürfelt wird.');
  assert.equal(localizeText('Could not resolve this round.', 'es'), 'No se pudo resolver esta ronda.');
});

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

test('allows rooms with up to ten players', () => {
  const players = Array.from({ length: MAX_PLAYERS }, (_, index) => player(`p${index}`));
  const state = { ...createMatch(players[0]), players };
  assert.equal(beginGame(state).players.length, 10);
  assert.throws(() => beginGame({ ...state, players: [...players, player('p10')] }), /2–10 players/);
});

test('players choose build or bank independently, with a die only for builders', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ]);
  const bankTurn = beginBankingTurn(state, 'a');
  const building = beginBuildingTurn(bankTurn, 'b', 5);
  assert.equal(isLegalAction(state.players[0], bankAction('a1'), 'choose', null), true);
  assert.throws(() => beginBuildingTurn(building, 'b', 2), /already chosen/);
  assert.equal(isLegalAction(state.players[1], buildAction([{ towerId: null, elements: 2 }]), 'build', 5), true);
  const result = resolveRound(building, [
    { playerId: 'a', action: bankAction('a1') },
    { playerId: 'b', action: buildAction([{ towerId: null, elements: 2 }]) },
  ], [1, 2]);
  assert.equal(result.players[0].score, 3);
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
  const building = beginBuildingTurn(state, 'a', 6);
  const withBothRolls = beginBuildingTurn(building, 'b', 1);
  assert.equal(isLegalAction(state.players[0], allocation, 'build', 6), true);
  const result = resolveRound(withBothRolls, [
    { playerId: 'a', action: allocation },
    { playerId: 'b', action: buildAction() },
  ], [1, 1]);
  assert.deepEqual(result.players[0].towers.map((tower) => tower.height), [4, 4, 1]);
  assert.equal(result.history[0].actions[0].description, 'added 6 floors');
});

test('limits standing towers to six', () => {
  const fiveTowers = Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, height: 1 }));
  const building = beginBuildingTurn(activeState([
    player('a', { towers: fiveTowers }),
    player('b'),
  ]), 'a', 3);
  assert.equal(isLegalAction(building.players[0], buildAction([
    { towerId: null, elements: 1 },
  ]), 'build', 3), true);
  const fourTowers = fiveTowers.slice(0, 4);
  const twoNewTowerTurn = beginBuildingTurn(activeState([
    player('a', { towers: fourTowers }),
    player('b'),
  ]), 'a', 2);
  assert.equal(isLegalAction(twoNewTowerTurn.players[0], buildAction([
    { towerId: null, elements: 1, slot: 4 },
    { towerId: null, elements: 1, slot: 5 },
  ]), 'build', 2), false);

  const sixTowers = [...fiveTowers, { id: 'a5', height: 1 }];
  const full = beginBuildingTurn(activeState([
    player('a', { towers: sixTowers }),
    player('b'),
  ]), 'a', 3);
  assert.equal(isLegalAction(full.players[0], buildAction([
    { towerId: null, elements: 1 },
  ]), 'build', 3), false);
  assert.equal(isLegalAction(full.players[0], buildAction([
    { towerId: 'a0', elements: 1 },
  ]), 'build', 3), true);
});

test('builds a new tower in its selected slot and retains that slot', () => {
  const state = activeState([player('a'), player('b')]);
  const firstTurn = resolveRound(
    beginBuildingTurn(beginBuildingTurn(state, 'a', 3), 'b', 2),
    [
      { playerId: 'a', action: buildAction([{ towerId: null, elements: 3, slot: 5 }]) },
      { playerId: 'b', action: buildAction() },
    ],
    [1, 1],
  );
  assert.equal(firstTurn.players[0].towers[0].slot, 5);
  assert.equal(firstTurn.players[0].towers[0].height, 3);

  const nextTurn = beginBuildingTurn(beginBuildingTurn(beginNextRound(firstTurn), 'a', 1), 'b', 1);
  const result = resolveRound(nextTurn, [
    { playerId: 'a', action: buildAction() },
    { playerId: 'b', action: buildAction() },
  ], [1, 1]);
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

test('the shared wind waits until every parallel action is submitted', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 7 }] }),
    player('b', { towers: [{ id: 'b1', height: 7 }] }),
  ]);
  const firstTurn = beginBankingTurn(state, 'a');
  const building = beginBuildingTurn(firstTurn, 'b', 2);
  assert.throws(() => resolveRound(building, [
    { playerId: 'a', action: bankAction('a1') },
  ], [3, 3]), /Every player must choose and submit/);
  const result = resolveRound(building, [
    { playerId: 'a', action: bankAction('a1') },
    { playerId: 'b', action: buildAction() },
  ], [3, 3]);
  assert.deepEqual(result.history[0].dice, [3, 3]);
  assert.deepEqual(result.history[0].fallenCounts, { a: 0, b: 1 });
  assert.equal(result.history[0].toppled[0].playerId, 'b');
});

test('a toppled tower is removed and a new tower can be built next round', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 7, slot: 0 }] }),
    player('b'),
  ]);
  const firstRound = resolveRound(
    beginBuildingTurn(beginBuildingTurn(state, 'a', 1), 'b', 1),
    [
      { playerId: 'a', action: buildAction([{ towerId: 'a1', elements: 1 }]) },
      { playerId: 'b', action: buildAction() },
    ],
    [6, 6],
  );
  assert.deepEqual(firstRound.players[0].towers, []);

  const nextTurn = beginBuildingTurn(
    beginBuildingTurn(beginNextRound(firstRound), 'a', 2),
    'b',
    1,
  );
  const newTowerAction = buildAction([{ towerId: null, elements: 2, slot: 0 }]);
  assert.equal(isLegalAction(nextTurn.players[0], newTowerAction, 'build', 2), true);
  const secondRound = resolveRound(nextTurn, [
    { playerId: 'a', action: newTowerAction },
    { playerId: 'b', action: buildAction() },
  ], [1, 1]);
  assert.deepEqual(secondRound.players[0].towers, [
    { id: 'tower-1', height: 2, slot: 0 },
  ]);
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
  assert.deepEqual(result.history[0].pointsEarned, [
    { playerId: 'a', points: 3 },
    { playerId: 'b', points: 0 },
  ]);
});

test('winning after scoring prevents any towers from toppling that turn', () => {
  const state = activeState([
    player('a', { score: 10, towers: [{ id: 'a1', height: 2 }, { id: 'a2', height: 7 }] }),
    player('b', { towers: [{ id: 'b1', height: 7 }] }),
  ], 13);
  const firstTurn = beginBankingTurn(state, 'a');
  const secondTurn = beginBuildingTurn(firstTurn, 'b', 2);
  assert.equal(secondTurn.players[0].score, 10);
  const result = resolveRound(secondTurn, [
    { playerId: 'a', action: bankAction('a1') },
    { playerId: 'b', action: buildAction() },
  ], [6, 6]);
  assert.equal(result.status, 'finished');
  assert.equal(result.players[0].score, 13);
  assert.equal(result.players[0].roomWins, 1);
  assert.deepEqual(result.winnerIds, ['a']);
  assert.deepEqual(result.players.map((item) => item.towers.map((tower) => tower.id)), [['a2'], ['b1']]);
  assert.deepEqual(result.history[0].toppled, []);
  assert.deepEqual(result.history[0].fallenCounts, { a: 0, b: 0 });
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
  assert.deepEqual(rematch.roundTurnRolls, []);
  assert.equal(rematch.targetPoints, 10);
  assert.equal(rematch.players[0].score, 0);
  assert.equal(rematch.players[0].roomWins, 1);

  const lobby = returnToLobby(finished);
  assert.equal(lobby.status, 'lobby');
  assert.deepEqual(lobby.roundTurnRolls, []);
  assert.equal(lobby.targetPoints, 10);
  assert.equal(lobby.players[0].roomWins, 1);
});

test('rejects early die rolls, invalid allocations, and invalid wind', () => {
  const state = activeState([player('a'), player('b')]);
  const earlyBuild = buildAction([{ towerId: null, elements: 1 }]);
  assert.equal(isLegalAction(state.players[0], earlyBuild, 'choose', null), false);
  assert.throws(() => beginBuildingTurn(state, 'a', 7), /1 to 6/);
  const building = beginBuildingTurn(state, 'a', 3);
  assert.equal(isLegalAction(state.players[0], buildAction([{ towerId: null, elements: 4 }]), 'build', 3), false);
  assert.equal(isLegalAction(state.players[0], buildAction([{ towerId: 'missing', elements: 1 }]), 'build', 3), false);
  const finalTurn = beginBuildingTurn(building, 'b', 3);
  assert.throws(() => resolveRound(finalTurn, [
    { playerId: 'a', action: buildAction([{ towerId: null, elements: 1 }]) },
    { playerId: 'b', action: buildAction() },
  ], [1, 7]), /1 to 6/);
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
  const firstTurn = beginBuildingTurn(beginBuildingTurn(state, 'a', 1), 'b', 1);
  const result = resolveRound(firstTurn, [
    { playerId: 'a', action: buildAction([{ towerId: null, elements: 1 }]) },
    { playerId: 'b', action: buildAction() },
  ], [6, 6]);
  const view = createPlayerView(result, 'a');
  assert.deepEqual(view.players.find((item) => item.id === 'b').towers, []);
  assert.deepEqual(view.history[0].toppled.map((item) => item.playerId), ['a', 'b']);
  assert.deepEqual(view.history[0].fallenCounts, { a: 1, b: 1 });
});

test('player views reveal round points without exposing opponents banking details', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }] }),
    player('b', { towers: [{ id: 'b1', height: 3 }] }),
  ]);
  const firstTurn = beginBankingTurn(beginBuildingTurn(state, 'b', 1), 'a');
  const result = resolveRound(firstTurn, [
    { playerId: 'a', action: bankAction('a1') },
    { playerId: 'b', action: buildAction() },
  ], [1, 1]);
  const view = createPlayerView(result, 'a');
  assert.deepEqual(view.history[0].pointsEarned, [
    { playerId: 'a', points: 3 },
    { playerId: 'b', points: 0 },
  ]);
  assert.deepEqual(view.history[0].banked, [
    { playerId: 'a', towerHeight: 2, points: 3 },
  ]);
  assert.deepEqual(view.history[0].actions.map((action) => action.playerId), ['a']);
  const update = parseMessage(JSON.stringify({
    type: 'state',
    state: view,
    submittedCount: 2,
    playerId: 'a',
  }));
  assert.deepEqual(update.state.history[0].pointsEarned, view.history[0].pointsEarned);
});

test('protocol preserves per-player recovery credentials and submission state', () => {
  const join = { type: 'join', playerId: 'guest', name: 'Guest', resumeToken: 'secret-token' };
  assert.deepEqual(parseMessage(JSON.stringify(join)), join);

  const state = createMatch(player('host'));
  const update = {
    type: 'state',
    state,
    submittedCount: 1,
    playerId: 'guest',
    resumeToken: 'secret-token',
    isSubmitted: true,
  };
  assert.deepEqual(parseMessage(JSON.stringify(update)), update);

  const parallelRound = beginBuildingTurn(
    beginBankingTurn(activeState([player('host'), player('guest')]), 'guest'),
    'host',
    4,
  );
  const hostView = createPlayerView(parallelRound, 'host');
  assert.deepEqual(hostView.roundTurnRolls, [
    { playerId: 'guest', choice: 'bank', die: null },
    { playerId: 'host', choice: 'build', die: 4 },
  ]);
  assert.deepEqual(parseMessage(JSON.stringify({
    type: 'state',
    state: hostView,
    submittedCount: 0,
    playerId: 'host',
  })).state.roundTurnRolls, hostView.roundTurnRolls);

  const tenPlayers = Array.from({ length: MAX_PLAYERS }, (_, index) => player(`p${index}`));
  const fullLobby = { ...createMatch(tenPlayers[0]), players: tenPlayers };
  assert.equal(parseMessage(JSON.stringify({
    type: 'state',
    state: fullLobby,
    submittedCount: 0,
    playerId: 'p0',
  })).state.players.length, MAX_PLAYERS);
});
