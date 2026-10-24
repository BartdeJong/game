export const MAX_PLAYERS = 5;
export const MIN_PLAYERS = 2;
export const DEFAULT_WIN_POINTS = 80;
export const MIN_WIN_POINTS = 10;
export const MAX_WIN_POINTS = 200;

export interface Tower {
  id: string;
  height: number;
}

export interface Player {
  id: string;
  name: string;
  score: number;
  bankedTowers: number;
  roomWins: number;
  towers: Tower[];
  connected: boolean;
  isBot?: boolean;
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
  fallenCounts: Record<string, number>;
  actions: RoundAction[];
  banked: { playerId: string; towerHeight: number; points: number }[];
  toppled: { playerId: string; towerId: string; height: number; limit: number }[];
}

export interface MatchState {
  status: 'lobby' | 'choice' | 'resolution' | 'finished';
  round: number;
  targetPoints: number;
  dice: [number, number] | null;
  players: Player[];
  history: RoundResolution[];
  winnerIds: string[];
  nextTowerId: number;
}

export function createMatch(host: Player, targetPoints = DEFAULT_WIN_POINTS): MatchState {
  validateTargetPoints(targetPoints);
  return {
    status: 'lobby',
    round: 0,
    targetPoints,
    dice: null,
    players: [{ ...host, towers: [], score: 0, bankedTowers: 0, roomWins: host.roomWins ?? 0, connected: true }],
    history: [],
    winnerIds: [],
    nextTowerId: 1,
  };
}

export function validateTargetPoints(targetPoints: number): void {
  if (!Number.isInteger(targetPoints) || targetPoints < MIN_WIN_POINTS || targetPoints > MAX_WIN_POINTS) {
    throw new Error(`The win target must be a whole number from ${MIN_WIN_POINTS} to ${MAX_WIN_POINTS}.`);
  }
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

export function beginGame(state: MatchState): MatchState {
  if (state.status !== 'lobby' || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    throw new Error('The room needs 2–5 players before the game can start.');
  }
  validateTargetPoints(state.targetPoints);
  return { ...state, status: 'choice', round: 1, dice: null, history: [], winnerIds: [] };
}

export function returnToLobby(state: MatchState): MatchState {
  if (state.status !== 'finished') {
    throw new Error('The room lobby can only be reopened after a game finishes.');
  }
  return {
    ...state,
    status: 'lobby',
    round: 0,
    dice: null,
    players: resetGamePlayers(state.players),
    history: [],
    winnerIds: [],
    nextTowerId: 1,
  };
}

export function beginRematch(state: MatchState): MatchState {
  if (state.status !== 'finished') {
    throw new Error('A rematch can only start after a game finishes.');
  }
  if (
    state.players.length < MIN_PLAYERS ||
    state.players.length > MAX_PLAYERS ||
    state.players.some((player) => !player.connected)
  ) {
    throw new Error('Remove disconnected players before starting another game.');
  }
  return {
    ...state,
    status: 'choice',
    round: 1,
    dice: null,
    players: resetGamePlayers(state.players),
    history: [],
    winnerIds: [],
    nextTowerId: 1,
  };
}

function resetGamePlayers(players: Player[]): Player[] {
  return players.map((player) => ({
    ...player,
    score: 0,
    bankedTowers: 0,
    towers: [],
  }));
}

export function beginNextRound(state: MatchState): MatchState {
  if (state.status !== 'resolution') {
    throw new Error('The next round can only start after a round resolves.');
  }
  return { ...state, status: 'choice', round: state.round + 1, dice: null };
}

export function createPlayerView(state: MatchState, playerId: string): MatchState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      towers: player.id === playerId ? player.towers.map((tower) => ({ ...tower })) : [],
    })),
    history: state.history.map((round) => ({
      ...round,
      actions: round.actions.filter((action) => action.playerId === playerId),
      banked: round.banked.filter((banked) => banked.playerId === playerId),
      toppled: round.toppled.filter((tower) => tower.playerId === playerId),
      fallenCounts: { ...round.fallenCounts },
    })),
  };
}

export function resolveRound(
  state: MatchState,
  actions: Map<string, PlayerAction>,
  dice: [number, number],
): MatchState {
  if (state.status !== 'choice' || state.dice !== null) {
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
  validateDice(dice);

  const players = state.players.map((player) => ({
    ...player,
    towers: player.towers.map((tower) => ({ ...tower })),
  }));
  let nextTowerId = state.nextTowerId;
  const wind = dice[0] + dice[1];
  const resolution: RoundResolution = {
    round: state.round,
    dice: [...dice],
    wind,
    fallenCounts: Object.fromEntries(players.map((player) => [player.id, 0])),
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
        resolution.fallenCounts[player.id] = (resolution.fallenCounts[player.id] ?? 0) + 1;
      } else {
        standing.push(tower);
      }
    }
    player.towers = standing;
  }

  const gameEnded = players.some((player) => player.score >= state.targetPoints);
  const highScore = Math.max(...players.map((player) => player.score));
  const winnerIds = gameEnded
    ? players.filter((player) => player.score === highScore).map((player) => player.id)
    : [];
  if (gameEnded) {
    for (const player of players) {
      if (winnerIds.includes(player.id)) player.roomWins += 1;
    }
  }

  return {
    ...state,
    dice: [...dice],
    status: gameEnded ? 'finished' : 'resolution',
    players,
    history: [...state.history, resolution],
    winnerIds,
    nextTowerId,
  };
}

function validateDice(dice: [number, number]): void {
  if (dice.length !== 2 || dice.some((value) => !Number.isInteger(value) || value < 1 || value > 6)) {
    throw new Error('Each die must show a whole number from 1 to 6.');
  }
}
