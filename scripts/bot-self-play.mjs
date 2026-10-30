import {
  beginGame,
  beginNextRound,
  beginTurnRoll,
  chooseTurnMode,
  createMatch,
  resolveRound,
} from '../.test-build/src/game.js';
import { chooseBotAction } from '../.test-build/src/bot.js';

const gameCount = Number(process.argv[2] ?? 100);
const initialSeed = Number(process.argv[3] ?? 20261030);
const targetPoints = 80;
const maxRounds = 200;
const difficulties = ['easy', 'normal', 'hard', 'ultra', 'extreme'];

if (!Number.isInteger(gameCount) || gameCount < 1) {
  throw new Error('Provide a positive whole number of games.');
}
if (!Number.isInteger(initialSeed) || initialSeed < 0 || initialSeed > 0xffffffff) {
  throw new Error('Provide a seed from 0 to 4294967295.');
}

const wins = Object.fromEntries(difficulties.map((difficulty) => [difficulty, 0]));
const totalRounds = Object.fromEntries(difficulties.map((difficulty) => [difficulty, 0]));
let draws = 0;

for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
  const random = createRandomGenerator((initialSeed + gameIndex) >>> 0);
  const players = rotate(difficulties, gameIndex).map((difficulty, seat) => ({
    id: `bot-${seat}`,
    name: difficulty,
    score: 0,
    bankedTowers: 0,
    roomWins: 0,
    towers: [],
    connected: true,
    isBot: true,
    botDifficulty: difficulty,
    ...(difficulty === 'extreme' ? { extremeSearchDepth: 1 } : {}),
  }));
  let state = beginGame({ ...createMatch(players[0], targetPoints), players });

  while (state.status !== 'finished' && state.round <= maxRounds) {
    const turnDice = new Map();
    for (const player of state.players) {
      const die = rollDie(random);
      turnDice.set(player.id, die);
      state = beginTurnRoll(state, player.id, die);
    }

    const actions = [];
    for (const player of state.players) {
      const opponents = state.players
        .filter((opponent) => opponent.id !== player.id)
        .map((opponent) => ({ player: opponent, turnDie: turnDice.get(opponent.id) }));
      const action = chooseBotAction(
        player,
        targetPoints,
        turnDice.get(player.id),
        opponents,
      );
      state = chooseTurnMode(state, player.id, action.kind);
      actions.push({ playerId: player.id, action });
    }

    state = resolveRound(state, actions, [rollDie(random), rollDie(random)]);
    if (state.status !== 'finished') state = beginNextRound(state);
  }

  if (state.status === 'finished') {
    for (const winnerId of state.winnerIds) {
      const winner = state.players.find((player) => player.id === winnerId);
      if (winner) wins[winner.botDifficulty] += 1;
    }
  } else {
    draws += 1;
  }
  for (const player of state.players) totalRounds[player.botDifficulty] += state.round;
}

console.log(`Self-play: ${gameCount} games, target ${targetPoints}, seed ${initialSeed}`);
for (const difficulty of difficulties) {
  const winRate = (wins[difficulty] / gameCount * 100).toFixed(1);
  const averageRounds = (totalRounds[difficulty] / gameCount).toFixed(1);
  console.log(`${difficulty.padEnd(7)} ${wins[difficulty]} wins (${winRate}%) · ${averageRounds} average rounds`);
}
console.log(`draws   ${draws}`);

function createRandomGenerator(seed) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function rollDie(random) {
  return 1 + Math.floor(random() * 6);
}

function rotate(values, offset) {
  return values.map((_, index) => values[(index + offset) % values.length]);
}
