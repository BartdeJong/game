export const MAX_PLAYERS = 5;
export const MIN_PLAYERS = 2;

export interface Tower {
  id: string;
  height: number;
}

export interface Player {
  id: string;
  name: string;
  score: number;
  bankedTowers: number;
  towers: Tower[];
  connected: boolean;
}

export type PlayerAction =
  | { kind: 'new' }
  | { kind: 'build'; towerId: string }
  | { kind: 'bank'; towerId: string };

export interface RoundAction {
  playerId: string;
  description: string;
}

export interface RoundResolution {
  round: number;
  dice: [number, number];
  wind: number;
  actions: RoundAction[];
  banked: { playerId: string; towerHeight: number; points: number }[];
  toppled: { playerId: string; towerId: string; height: number; limit: number }[];
}

export interface MatchState {
  status: 'lobby' | 'choice' | 'resolution' | 'finished';
  round: number;
  dice: [number, number] | null;
  players: Player[];
  history: RoundResolution[];
  winnerIds: string[];
  nextTowerId: number;
}

export function createMatch(host: Player): MatchState {
  return {
    status: 'lobby',
    round: 0,
    dice: null,
    players: [{ ...host, towers: [], score: 0, bankedTowers: 0, connected: true }],
    history: [],
    winnerIds: [],
    nextTowerId: 1,
  };
}

export function heightLimit(height: number): number {
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('Tower height must be a positive integer.');
  }
  return height >= 7 ? 6 : 13 - height;
}

export function towerPoints(height: number): number {
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('Tower height must be a positive integer.');
  }
  return (height * (height + 1)) / 2;
}

export function isLegalAction(player: Player, action: PlayerAction): boolean {
  if (action.kind === 'new') return true;
  return player.towers.some((tower) => tower.id === action.towerId);
}

export function beginGame(state: MatchState, dice: [number, number]): MatchState {
  if (state.status !== 'lobby' || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    throw new Error('The room needs 2–5 players before the game can start.');
  }
  return { ...state, status: 'choice', round: 1, dice: [...dice], history: [], winnerIds: [] };
}

export function beginNextRound(state: MatchState, dice: [number, number]): MatchState {
  if (state.status !== 'resolution') {
    throw new Error('The next round can only start after a round resolves.');
  }
  return { ...state, status: 'choice', round: state.round + 1, dice: [...dice] };
}

export function resolveRound(
  state: MatchState,
  actions: Map<string, PlayerAction>,
): MatchState {
  if (state.status !== 'choice' || !state.dice) {
    throw new Error('There is no active round to resolve.');
  }
  if (actions.size !== state.players.length || state.players.some((player) => !actions.has(player.id))) {
    throw new Error('Every player must submit one action.');
  }
  for (const player of state.players) {
    const action = actions.get(player.id);
    if (!action || !isLegalAction(player, action)) {
      throw new Error(`Invalid action for ${player.name}.`);
    }
  }

  const players = state.players.map((player) => ({
    ...player,
    towers: player.towers.map((tower) => ({ ...tower })),
  }));
  let nextTowerId = state.nextTowerId;
  const wind = state.dice[0] + state.dice[1];
  const resolution: RoundResolution = {
    round: state.round,
    dice: [...state.dice],
    wind,
    actions: [],
    banked: [],
    toppled: [],
  };

  for (const player of players) {
    const action = actions.get(player.id)!;
    if (action.kind === 'new') {
      const id = `tower-${nextTowerId++}`;
      player.towers.push({ id, height: 1 });
      resolution.actions.push({ playerId: player.id, description: 'Started a tower' });
    } else if (action.kind === 'build') {
      const tower = player.towers.find((item) => item.id === action.towerId)!;
      tower.height += 1;
      resolution.actions.push({ playerId: player.id, description: `Added a floor (tower now ${tower.height})` });
    } else {
      const index = player.towers.findIndex((item) => item.id === action.towerId);
      const [tower] = player.towers.splice(index, 1);
      const points = towerPoints(tower.height);
      player.score += points;
      player.bankedTowers += 1;
      resolution.banked.push({ playerId: player.id, towerHeight: tower.height, points });
      resolution.actions.push({ playerId: player.id, description: `Banked height ${tower.height} (+${points})` });
    }
  }

  for (const player of players) {
    const standing: Tower[] = [];
    for (const tower of player.towers) {
      const limit = heightLimit(tower.height);
      if (wind >= limit) {
        resolution.toppled.push({ playerId: player.id, towerId: tower.id, height: tower.height, limit });
      } else {
        standing.push(tower);
      }
    }
    player.towers = standing;
  }

  const gameEnded = players.some((player) => player.bankedTowers >= 3);
  const highScore = Math.max(...players.map((player) => player.score));
  const winnerIds = gameEnded
    ? players.filter((player) => player.score === highScore).map((player) => player.id)
    : [];

  return {
    ...state,
    status: gameEnded ? 'finished' : 'resolution',
    players,
    history: [...state.history, resolution],
    winnerIds,
    nextTowerId,
  };
}
