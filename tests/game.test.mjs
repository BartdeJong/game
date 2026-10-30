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
  chooseTurnMode,
  DEFAULT_EXTREME_SEARCH_DEPTH,
  DEFAULT_WIN_POINTS,
  heightLimit,
  isExtremeSearchDepth,
  isLegalAction,
  MAX_PLAYERS,
  returnToLobby,
  resolveRound,
  beginTurnRoll,
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

function bankAction(towerIds) {
  return { kind: 'bank', towerIds: Array.isArray(towerIds) ? towerIds : [towerIds] };
}

function finishRound(state, actionsByPlayer, windDice, turnDice = {}) {
  let current = state;
  const actions = [];
  for (const activePlayer of state.players) {
    const turnAction = actionsByPlayer[activePlayer.id] ?? buildAction();
    if (!current.roundTurnRolls.some((turn) => turn.playerId === activePlayer.id)) {
      current = turnAction.kind === 'build'
        ? beginBuildingTurn(current, activePlayer.id, turnDice[activePlayer.id] ?? 6)
        : beginBankingTurn(current, activePlayer.id, turnDice[activePlayer.id] ?? 6);
    }
    actions.push({ playerId: activePlayer.id, action: turnAction });
  }
  return resolveRound(current, actions, windDice);
}

test('localizes interface text in the supported languages and preserves English', () => {
  assert.deepEqual(LANGUAGES.map((language) => language.code), ['en', 'nl', 'fy', 'de', 'fr', 'es', 'da']);
  assert.equal(localizeText('Host a game', 'en'), 'Host a game');
  assert.equal(localizeText('Host a game', 'nl'), 'Start een spel');
  assert.equal(localizeText('Bot difficulty', 'nl'), 'Robotmoeilijkheid');
  assert.equal(localizeText('Easy', 'nl'), 'Makkelijk');
  assert.equal(localizeText('Hard', 'fr'), 'Difficile');
  assert.equal(localizeText('Thinking…', 'nl'), 'Denkt na…');
  assert.equal(localizeText('Animate dice rolls', 'nl'), 'Dobbelsteenworpen animeren');
  assert.match(localizeText('When off, rolls stay visible but skip the full-screen reveal and die animation.', 'de'), /Vollbildanzeige/);
  assert.equal(localizeText('Roll a die first', 'nl'), 'Gooi eerst een dobbelsteen');
  assert.equal(localizeText('Bank 2 towers for +4 points', 'nl'), 'Bank 2 torens voor +4 punten');
  assert.equal(localizeText('3 pips · choosing', 'nl'), '3 ogen · kiezen');
  assert.deepEqual(
    ['nl', 'fy', 'de', 'fr', 'es', 'da'].map((language) => localizeText('You rolled 4', language)),
    ['Je gooide 4', 'Do smietst 4', 'Du hast eine 4 gewürfelt', 'Vous avez obtenu 4', 'Sacaste un 4', 'Du slog 4'],
  );
  assert.match(
    localizeText('Reach 80 points to win. Roll a die, then choose to build or bank. Use the result as your building budget or bank up to that many towers.', 'nl'),
    /Gooi eerst een dobbelsteen/,
  );
  assert.equal(
    localizeText('Roll one die, then choose Build or Bank. Build spends up to the roll in floors. Bank scores up to the roll in towers; you may bank fewer. Banked towers are protected from the wind.', 'nl'),
    'Kast één dobbelsteen en kies daarna Bouwen of Banken. Bij bouwen gebruik je maximaal de worp aan verdiepingen. Bij banken scoor je maximaal het aantal ogen aan torens; je mag er minder banken. Gebankte torens zijn beschermd tegen de wind.',
  );
  assert.equal(localizeText('Host a game', 'fy'), 'Begjin in spul');
  assert.equal(localizeText('Host a game', 'de'), 'Spiel hosten');
  assert.equal(localizeText('Host a game', 'fr'), 'Héberger une partie');
  assert.equal(localizeText('Host a game', 'es'), 'Crear partida');
  assert.equal(localizeText('Host a game', 'da'), 'Vær vært for et spil');
  assert.equal(localizeText('LEADER', 'nl'), 'KOPLOPER');
  assert.equal(localizeText('ROUND 3 · PARALLEL TURNS', 'fr'), 'MANCHE 3 · TOURS SIMULTANÉS');
  assert.equal(localizeText('Tower, height 4, worth 10 points', 'nl'), 'Toren, hoogte 4, waarde 10 punten');
  assert.equal(localizeText('Shared wind: 2 plus 5 equals 7', 'es'), 'Viento compartido: 2 más 5 es 7');
  assert.equal(localizeText('e.g. Alex', 'fr'), 'ex. Alex');
  assert.equal(localizeText('e.g. 7K2M-Q9RX', 'da'), 'fx 7K2M-Q9RX');
  assert.equal(localizeText('Every player must choose and submit one action before the shared wind is rolled.', 'de'), 'Alle Spieler müssen eine Aktion wählen und abgeben, bevor der gemeinsame Wind gewürfelt wird.');
  const windResolutionRules = 'Round order: resolve everyone’s submitted builds and banks, then award bank points. If anyone reaches the target, the game ends before the wind check. Otherwise, calculate protection from towers still standing (banked towers are removed and do not protect the skyline), then check all remaining towers together. Each standing tower beyond the first adds +1 to every tower’s base limit, up to +3. A tower topples when the two-die wind total is equal to or greater than its base limit plus protection. Base limit by height: 1 = 12, 2 = 11, 3 = 10, 4 = 9, 5 = 8, 6 = 7, 7 = 6, 8 = 5, 9 = 4, 10 = 3, 11+ = 2.';
  assert.deepEqual(
    LANGUAGES.slice(1).map(({ code }) => localizeText(windResolutionRules, code) !== windResolutionRules),
    [true, true, true, true, true, true],
  );
  assert.equal(localizeText('Could not resolve this round.', 'es'), 'No se pudo resolver esta ronda.');
  assert.equal(localizeText('  Your skyline ', 'nl'), '  Jouw skyline ');
  assert.equal(localizeText('Win target: ', 'fr'), 'Score à atteindre : ');
  assert.equal(localizeText('Connecting to the host. Keep this page open; the lobby will appear when the connection is ready.', 'de'), 'Verbindung zum Host wird hergestellt. Lass diese Seite geöffnet; die Lobby erscheint, sobald die Verbindung bereit ist.');
  assert.equal(localizeText('The room is not connected to the signaling service.', 'es'), 'La sala no está conectada al servicio de señalización.');
  assert.deepEqual(
    ['nl', 'fy', 'de', 'fr', 'es', 'da'].map((language) =>
      `${localizeText('Everyone’s ', language)}${localizeText('turn.', language)}`),
    [
      'Iedereen is aan de beurt.',
      'Elkenien is oan de beurt.',
      'Alle sind an der Reihe.',
      'C’est au tour de chacun.',
      'Es el turno de todos.',
      'Alle er på tur.',
    ],
  );
  assert.equal(localizeText('Bank', 'nl'), 'Veiligstellen');
  assert.equal(localizeText('Bank tower for +3 points', 'nl'), 'Stel de toren veilig voor +3 punten');
});

test('uses approved base wind limits and triangular bank score', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(heightLimit),
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2],
  );
  assert.deepEqual([1, 2, 3, 4, 5].map(towerPoints), [1, 3, 6, 10, 15]);
});

test('defaults the room win target to 80 and validates configured targets', () => {
  assert.equal(createMatch(player('host')).targetPoints, 80);
  assert.equal(createMatch(player('host'), 10).targetPoints, 10);
  assert.equal(createMatch(player('host'), 200).targetPoints, 200);
  assert.throws(() => createMatch(player('host'), 9), /10 to 200/);
  assert.throws(() => createMatch(player('host'), 80.5), /whole number/);
});

test('validates Extreme Robot search depth settings', () => {
  assert.equal(DEFAULT_EXTREME_SEARCH_DEPTH, 8);
  assert.equal(isExtremeSearchDepth(1), true);
  assert.equal(isExtremeSearchDepth(50), true);
  assert.equal(isExtremeSearchDepth(500), true);
  assert.equal(isExtremeSearchDepth(0), false);
  assert.equal(isExtremeSearchDepth(50.5), false);
  assert.equal(isExtremeSearchDepth(501), false);
});

test('allows rooms with up to ten players', () => {
  const players = Array.from({ length: MAX_PLAYERS }, (_, index) => player(`p${index}`));
  const state = { ...createMatch(players[0]), players };
  assert.equal(beginGame(state).players.length, 10);
  assert.throws(() => beginGame({ ...state, players: [...players, player('p10')] }), /2–10 players/);
});

test('players roll first, then choose build or bank', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }] }),
    player('b'),
  ]);
  const rolled = beginTurnRoll(state, 'a', 4);
  assert.deepEqual(rolled.roundTurnRolls, [{ playerId: 'a', choice: 'choose', die: 4 }]);
  assert.equal(isLegalAction(state.players[0], bankAction('a1'), 'choose', 4), true);
  assert.equal(isLegalAction(state.players[0], bankAction(['a1', 'a1']), 'choose', 4), false);
  const bankTurn = chooseTurnMode(rolled, 'a', 'bank');
  const building = beginBuildingTurn(bankTurn, 'b', 5);
  assert.throws(() => beginBuildingTurn(building, 'b', 2), /already chosen/);
  assert.equal(isLegalAction(state.players[1], buildAction([{ towerId: null, elements: 2 }]), 'build', 5), true);
  const result = resolveRound(building, [
    { playerId: 'a', action: bankAction('a1') },
    { playerId: 'b', action: buildAction([{ towerId: null, elements: 2 }]) },
  ], [1, 2]);
  assert.equal(result.players[0].score, 3);
  assert.deepEqual(result.history[0].turnRolls, [
    { playerId: 'a', choice: 'bank', die: 4 },
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
  const firstTurn = beginBankingTurn(state, 'a', 2);
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

test('a toppled tower remains visible during resolution and is removed before the next round', () => {
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
  assert.deepEqual(firstRound.players[0].towers, [
    { id: 'a1', height: 8, slot: 0, toppled: true },
  ]);

  const nextRound = beginNextRound(firstRound);
  assert.deepEqual(nextRound.players[0].towers, []);
  const nextTurn = beginBuildingTurn(beginBuildingTurn(nextRound, 'a', 2), 'b', 1);
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

test('an unprotected tower of height eleven topples at wind two', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 11 }] }),
    player('b'),
  ]);
  const result = finishRound(state, {}, [1, 1]);
  assert.deepEqual(result.history[0].toppled, [
    { playerId: 'a', towerId: 'a1', height: 11, limit: 2 },
  ]);
  assert.deepEqual(result.players[0].towers, [
    { id: 'a1', height: 11, slot: 0, toppled: true },
  ]);
});

test('round results retain the wind protection used before toppled towers are removed', () => {
  const state = activeState([
    player('a', { towers: [
      { id: 'a1', height: 7 },
      { id: 'a2', height: 5 },
      { id: 'a3', height: 5 },
    ] }),
    player('b'),
  ]);
  const result = finishRound(state, {}, [4, 5]);
  assert.deepEqual(result.players[0].towers.map((tower) => tower.id), ['a1', 'a2', 'a3']);
  assert.equal(result.players[0].towers[0].toppled, true);
  assert.equal(result.history[0].windShields.a, 2);
  assert.deepEqual(result.history[0].toppled.map((tower) => tower.limit), [8]);
});

test('banking can score fewer towers than the die and protects them from wind', () => {
  const state = activeState([
    player('a', { towers: [
      { id: 'a1', height: 2 },
      { id: 'a2', height: 1 },
      { id: 'a3', height: 1 },
    ] }),
    player('b'),
  ]);
  assert.equal(isLegalAction(state.players[0], bankAction(['a1', 'a2']), 'choose', 3), true);
  assert.equal(isLegalAction(state.players[0], bankAction(['a1', 'a2', 'a3']), 'choose', 2), false);
  const result = finishRound(state, { a: bankAction(['a1', 'a2']) }, [1, 1], { a: 3 });
  assert.equal(result.players[0].score, 4);
  assert.equal(result.players[0].bankedTowers, 2);
  assert.deepEqual(result.players[0].towers.map((tower) => tower.id), ['a3']);
  assert.deepEqual(result.history[0].banked[0], { playerId: 'a', towerHeight: 2, points: 3 });
  assert.deepEqual(result.history[0].banked[1], { playerId: 'a', towerHeight: 1, points: 1 });
  assert.equal(result.history[0].turnRolls[0].die, 3);
  assert.deepEqual(result.history[0].pointsEarned, [
    { playerId: 'a', points: 4 },
    { playerId: 'b', points: 0 },
  ]);
});

test('winning after scoring prevents any towers from toppling that turn', () => {
  const state = activeState([
    player('a', { score: 10, towers: [{ id: 'a1', height: 2 }, { id: 'a2', height: 7 }] }),
    player('b', { towers: [{ id: 'b1', height: 7 }] }),
  ], 13);
  const firstTurn = beginBankingTurn(state, 'a', 2);
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

test('robots choose banking after rolling or choose building and allocate the rolled die', () => {
  const easyRobot = player('robot', { isBot: true, botDifficulty: 'easy' });
  assert.deepEqual(chooseBotTurnChoice(easyRobot, 80, 4), { kind: 'build' });
  assert.deepEqual(chooseBotBuildAction(easyRobot, 4), {
    kind: 'build',
    placements: [{ towerId: null, elements: 4, slot: 0 }],
  });
  const readyToWin = player('robot', {
    score: 7,
    botDifficulty: 'easy',
    towers: [{ id: 't1', height: 2 }],
  });
  assert.deepEqual(chooseBotTurnChoice(readyToWin, 10, 4), { kind: 'bank', towerIds: ['t1'] });
  const towersToBank = player('robot', {
    botDifficulty: 'easy',
    towers: [{ id: 't1', height: 5 }, { id: 't2', height: 4 }, { id: 't3', height: 1 }],
  });
  assert.deepEqual(chooseBotTurnChoice(towersToBank, 80, 2), { kind: 'bank', towerIds: ['t1', 't2'] });
});

test('robots respect difficulty strategy and choose legal moves', () => {
  const towers = Array.from({ length: 4 }, (_, slot) => ({
    id: `t${slot}`,
    height: 5,
    slot,
  }));
  assert.deepEqual(
    chooseBotTurnChoice(player('easy', { botDifficulty: 'easy', towers }), 80, 1),
    { kind: 'bank', towerIds: ['t0'] },
  );
  assert.deepEqual(
    chooseBotTurnChoice(player('normal', { botDifficulty: 'normal', towers }), 80, 1),
    { kind: 'build' },
  );
  assert.deepEqual(
    chooseBotTurnChoice(player('hard', { botDifficulty: 'hard', score: 7, towers: [{ id: 't1', height: 2, slot: 0 }] }), 10, 2),
    { kind: 'bank', towerIds: ['t1'] },
  );
  assert.deepEqual(
    chooseBotTurnChoice(player('ultra', { botDifficulty: 'ultra', score: 7, towers: [{ id: 't1', height: 2, slot: 0 }] }), 10, 2),
    { kind: 'bank', towerIds: ['t1'] },
  );

  for (const difficulty of ['easy', 'normal', 'hard', 'ultra']) {
    const robot = player('robot', {
      isBot: true,
      botDifficulty: difficulty,
      towers: [{ id: 't1', height: 4, slot: 0 }, { id: 't2', height: 2, slot: 1 }],
    });
    assert.equal(isLegalAction(robot, chooseBotBuildAction(robot, 6, 80), 'build', 6), true);
    const choice = chooseBotTurnChoice(robot, 80, 6);
    if (choice.kind === 'bank') {
      assert.equal(isLegalAction(robot, { kind: 'bank', towerIds: choice.towerIds }, 'choose', 6), true);
    }
  }
});

test('Extreme Robot banks when an opponent can win this round', () => {
  const extreme = player('extreme', {
    score: 10,
    botDifficulty: 'extreme',
    towers: [{ id: 'own', height: 5, slot: 0 }],
  });
  const opponent = player('opponent', {
    score: 75,
    towers: [{ id: 'rival', height: 4, slot: 0 }],
  });

  assert.deepEqual(
    chooseBotTurnChoice(extreme, 80, 1, [{ player: opponent, turnDie: 1 }]),
    { kind: 'bank', towerIds: ['own'] },
  );
});

test('Ultra Hard uses next-round wind and banking outcomes to plan its build', () => {
  const towers = [0, 1, 2].map((slot) => ({ id: `t${slot}`, height: 1, slot }));
  const hard = player('hard', { botDifficulty: 'hard', towers });
  const ultra = player('ultra', { botDifficulty: 'ultra', towers });

  assert.deepEqual(chooseBotBuildAction(hard, 6, 80), {
    kind: 'build',
    placements: [{ towerId: null, elements: 6, slot: 3 }],
  });
  assert.deepEqual(chooseBotBuildAction(ultra, 6, 80), {
    kind: 'build',
    placements: [
      { towerId: 't2', elements: 2 },
      { towerId: null, elements: 4, slot: 3 },
    ],
  });
});

test('Extreme Robot returns a legal build after its deeper search', () => {
  const towers = [0, 1, 2].map((slot) => ({ id: `t${slot}`, height: 1, slot }));
  const extreme = player('extreme', { botDifficulty: 'extreme', extremeSearchDepth: 1, towers });
  const choice = chooseBotTurnChoice(extreme, 80, 6);
  assert.equal(choice.kind, 'build');
  const action = choice.action;

  assert.ok(action);
  assert.equal(isLegalAction(extreme, action, 'build', 6), true);
  assert.throws(
    () => chooseBotTurnChoice({ ...extreme, extremeSearchDepth: 501 }, 80, 6),
    /search depth must be a whole number from 1 to 500/,
  );
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
  assert.deepEqual(view.history[0].windShields, { a: 0 });
});

test('player views reveal round points without exposing opponents banking details', () => {
  const state = activeState([
    player('a', { towers: [{ id: 'a1', height: 2 }] }),
    player('b', { towers: [{ id: 'b1', height: 3 }] }),
  ]);
  const firstTurn = beginBankingTurn(beginBuildingTurn(state, 'b', 1), 'a', 3);
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
  assert.throws(() => parseMessage(JSON.stringify({ type: 'roll', playerId: 'guest' })), /unsupported game message/);
  const bankRequest = { type: 'action', playerId: 'guest', action: bankAction(['tower-1', 'tower-2']) };
  assert.deepEqual(parseMessage(JSON.stringify(bankRequest)), bankRequest);

  const robotState = {
    ...createMatch(player('host')),
    players: [player('host'), player('robot', {
      isBot: true,
      botDifficulty: 'extreme',
      extremeSearchDepth: 12,
    })],
  };
  const robotUpdate = parseMessage(JSON.stringify({
    type: 'state',
    state: robotState,
    submittedCount: 0,
    playerId: 'host',
  }));
  assert.equal(robotUpdate.type, 'state');
  assert.equal(robotUpdate.state.players[1].botDifficulty, 'extreme');
  assert.equal(robotUpdate.state.players[1].extremeSearchDepth, 12);
  const legacyRobotState = {
    ...createMatch(player('host')),
    players: [player('host'), player('robot', { isBot: true })],
  };
  assert.doesNotThrow(() => parseMessage(JSON.stringify({
    type: 'state',
    state: legacyRobotState,
    submittedCount: 0,
    playerId: 'host',
  })));
  assert.throws(() => parseMessage(JSON.stringify({
    type: 'state',
    state: { ...robotState, players: [robotState.players[0], { ...robotState.players[1], botDifficulty: 'expert' }] },
    submittedCount: 0,
    playerId: 'host',
  })), /unsupported game message/);
  assert.throws(() => parseMessage(JSON.stringify({
    type: 'state',
    state: {
      ...robotState,
      players: [robotState.players[0], { ...robotState.players[1], extremeSearchDepth: 501 }],
    },
    submittedCount: 0,
    playerId: 'host',
  })), /unsupported game message/);

  const state = createMatch(player('host'));
  assert.equal(state.rollAnimationEnabled, true);
  const update = {
    type: 'state',
    state,
    submittedCount: 1,
    playerId: 'guest',
    resumeToken: 'secret-token',
    isSubmitted: true,
  };
  assert.deepEqual(parseMessage(JSON.stringify(update)), update);
  const disabledAnimation = {
    ...update,
    state: { ...state, rollAnimationEnabled: false },
  };
  assert.equal(parseMessage(JSON.stringify(disabledAnimation)).state.rollAnimationEnabled, false);
  const legacyState = { ...state };
  delete legacyState.rollAnimationEnabled;
  assert.equal(parseMessage(JSON.stringify({ ...update, state: legacyState })).state.rollAnimationEnabled, undefined);
  assert.throws(() => parseMessage(JSON.stringify({
    ...update,
    state: { ...state, rollAnimationEnabled: 'no' },
  })), /unsupported game message/);

  const parallelRound = beginBuildingTurn(
    beginBankingTurn(activeState([player('host'), player('guest')]), 'guest', 2),
    'host',
    4,
  );
  const hostView = createPlayerView(parallelRound, 'host');
  assert.deepEqual(hostView.roundTurnRolls, [
    { playerId: 'guest', choice: 'bank', die: 2 },
    { playerId: 'host', choice: 'build', die: 4 },
  ]);
  assert.deepEqual(parseMessage(JSON.stringify({
    type: 'state',
    state: hostView,
    submittedCount: 0,
    playerId: 'host',
  })).state.roundTurnRolls, hostView.roundTurnRolls);

  const awaitingChoice = beginTurnRoll(activeState([player('host'), player('guest')]), 'guest', 3);
  const guestView = createPlayerView(awaitingChoice, 'guest');
  assert.deepEqual(parseMessage(JSON.stringify({
    type: 'state',
    state: guestView,
    submittedCount: 0,
    playerId: 'guest',
  })).state.roundTurnRolls, [{ playerId: 'guest', choice: 'choose', die: 3 }]);

  const tenPlayers = Array.from({ length: MAX_PLAYERS }, (_, index) => player(`p${index}`));
  const fullLobby = { ...createMatch(tenPlayers[0]), players: tenPlayers };
  assert.equal(parseMessage(JSON.stringify({
    type: 'state',
    state: fullLobby,
    submittedCount: 0,
    playerId: 'p0',
  })).state.players.length, MAX_PLAYERS);
});
