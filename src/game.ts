export const MAX_PLAYERS = 10;
export const MAX_TOWERS = 6;
export const MIN_PLAYERS = 2;
export const DEFAULT_WIN_POINTS = 80;
export const MIN_WIN_POINTS = 10;
export const MAX_WIN_POINTS = 200;
export const MAX_TOWER_SHIELD = 3;

export interface Tower {
  id: string;
  height: number;
  slot: number;
  toppled?: boolean;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard' | 'ultra' | 'extreme';

export interface Player {
  id: string;
  name: string;
  score: number;
  bankedTowers: number;
  roomWins: number;
  towers: Tower[];
  connected: boolean;
  isBot?: boolean;
  botDifficulty?: BotDifficulty;
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'easy' || value === 'normal' || value === 'hard' || value === 'ultra' || value === 'extreme';
}

export interface Placement {
  towerId: string | null;
  elements: number;
  slot?: number;
}

export type PlayerAction =
  | { kind: 'build'; placements: Placement[] }
  | { kind: 'bank'; towerIds: string[] };

export interface RoundAction {
  playerId: string;
  description: string;
}

export type RoundTurnRoll =
  | { playerId: string; choice: 'choose'; die: number }
  | { playerId: string; choice: 'build'; die: number }
  | { playerId: string; choice: 'bank'; die: number };

export interface RoundResolution {
  round: number;
  turnRolls: RoundTurnRoll[];
  dice: [number, number];
  wind: number;
  windShields: Record<string, number>;
  fallenCounts: Record<string, number>;
  actions: RoundAction[];
  banked: { playerId: string; towerHeight: number; points: number }[];
  pointsEarned?: { playerId: string; points: number }[];
  toppled: { playerId: string; towerId: string; height: number; limit: number }[];
}

export interface MatchState {
  status: 'lobby' | 'choice' | 'resolution' | 'finished';
  round: number;
  targetPoints: number;
  rollAnimationEnabled?: boolean;
  dice: [number, number] | null;
  roundTurnRolls: RoundTurnRoll[];
  roundActions: RoundAction[];
  roundBanked: { playerId: string; towerHeight: number; points: number }[];
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
    rollAnimationEnabled: true,
    dice: null,
    roundTurnRolls: [],
    roundActions: [],
    roundBanked: [],
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
  return Math.max(2, 13 - height);
}

export function towerPoints(height: number): number {
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('Tower height must be a positive integer.');
  }
  return (height * (height + 1)) / 2;
}

export function towerShield(towerCount: number): number {
  if (!Number.isInteger(towerCount) || towerCount < 0) {
    throw new Error('Tower count must be a non-negative integer.');
  }
  return Math.min(Math.max(0, towerCount - 1), MAX_TOWER_SHIELD);
}

export function isLegalAction(
  player: Player,
  action: PlayerAction,
  turnMode: 'choose' | 'build' | null,
  turnDie: number | null,
): boolean {
  if (action.kind === 'bank') {
    if (
      turnMode !== 'choose' ||
      turnDie === null ||
      !Number.isInteger(turnDie) ||
      turnDie < 1 ||
      turnDie > 6 ||
      !Array.isArray(action.towerIds) ||
      action.towerIds.length < 1 ||
      action.towerIds.length > turnDie
    ) return false;
    const towerIds = new Set(action.towerIds);
    return towerIds.size === action.towerIds.length &&
      action.towerIds.every((towerId) =>
        player.towers.some((tower) => tower.id === towerId && !tower.toppled));
  }
  if (
    turnMode !== 'build' ||
    turnDie === null ||
    !Number.isInteger(turnDie) ||
    turnDie < 1 ||
    turnDie > 6 ||
    !Array.isArray(action.placements)
  ) return false;
  const seenTowerIds = new Set<string>();
  const occupiedSlots = new Set(player.towers.map((tower, index) => tower.slot ?? index));
  let totalElements = 0;
  let newTowerCount = 0;
  for (const placement of action.placements) {
    if (!Number.isInteger(placement.elements) || placement.elements < 1) return false;
    totalElements += placement.elements;
    if (placement.towerId === null) {
      const slot = placement.slot ?? firstAvailableTowerSlot(occupiedSlots);
      if (
        slot === null ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot >= MAX_TOWERS ||
        occupiedSlots.has(slot)
      ) return false;
      occupiedSlots.add(slot);
      newTowerCount += 1;
      if (newTowerCount > 1) return false;
      continue;
    }
    if (
      seenTowerIds.has(placement.towerId) ||
      !player.towers.some((tower) => tower.id === placement.towerId)
    ) {
      return false;
    }
    seenTowerIds.add(placement.towerId);
  }
  return totalElements <= turnDie && player.towers.length + newTowerCount <= MAX_TOWERS;
}

export function beginGame(state: MatchState): MatchState {
  if (state.status !== 'lobby' || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    throw new Error(`The room needs ${MIN_PLAYERS}–${MAX_PLAYERS} players before the game can start.`);
  }
  validateTargetPoints(state.targetPoints);
  return {
    ...state,
    status: 'choice',
    round: 1,
    dice: null,
    roundTurnRolls: [],
    roundActions: [],
    roundBanked: [],
    players: state.players.map((player) => ({
      ...player,
      towers: player.towers.map((tower, slot) => ({ ...tower, slot })),
    })),
    history: [],
    winnerIds: [],
  };
}

export function beginBuildingTurn(state: MatchState, playerId: string, turnDie: number): MatchState {
  if (
    state.status !== 'choice' ||
    state.dice !== null ||
    !state.players.some((player) => player.id === playerId) ||
    state.roundTurnRolls.some((turn) => turn.playerId === playerId)
  ) throw new Error('This player has already chosen or is not in the active round.');
  validateDie(turnDie);
  return {
    ...state,
    roundTurnRolls: [...state.roundTurnRolls, { playerId, choice: 'build', die: turnDie }],
  };
}

export function beginTurnRoll(state: MatchState, playerId: string, turnDie: number): MatchState {
  if (
    state.status !== 'choice' ||
    state.dice !== null ||
    !state.players.some((player) => player.id === playerId) ||
    state.roundTurnRolls.some((turn) => turn.playerId === playerId)
  ) throw new Error('This player has already chosen or is not in the active round.');
  validateDie(turnDie);
  return {
    ...state,
    roundTurnRolls: [...state.roundTurnRolls, { playerId, choice: 'choose', die: turnDie }],
  };
}

export function chooseTurnMode(
  state: MatchState,
  playerId: string,
  choice: 'build' | 'bank',
): MatchState {
  if (state.status !== 'choice' || state.dice !== null) {
    throw new Error('There is no active round to choose an action for.');
  }
  const index = state.roundTurnRolls.findIndex((turn) =>
    turn.playerId === playerId && turn.choice === 'choose');
  if (index < 0) throw new Error('This player has not rolled for the active round.');
  const roundTurnRolls = [...state.roundTurnRolls];
  roundTurnRolls[index] = { playerId, choice, die: roundTurnRolls[index]!.die };
  return { ...state, roundTurnRolls };
}

export function beginBankingTurn(state: MatchState, playerId: string, turnDie: number): MatchState {
  if (
    state.status !== 'choice' ||
    state.dice !== null ||
    !state.players.some((player) => player.id === playerId) ||
    state.roundTurnRolls.some((turn) => turn.playerId === playerId)
  ) throw new Error('This player has already chosen or is not in the active round.');
  validateDie(turnDie);
  return {
    ...state,
    roundTurnRolls: [...state.roundTurnRolls, { playerId, choice: 'bank', die: turnDie }],
  };
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
    roundTurnRolls: [],
    roundActions: [],
    roundBanked: [],
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
    roundTurnRolls: [],
    roundActions: [],
    roundBanked: [],
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
    throw new Error('The next round can only start after the shared wind resolves.');
  }
  return {
    ...state,
    status: 'choice',
    round: state.round + 1,
    players: state.players.map((player) => ({
      ...player,
      towers: player.towers.filter((tower) => !tower.toppled),
    })),
    dice: null,
    roundTurnRolls: [],
    roundActions: [],
    roundBanked: [],
  };
}

export function createPlayerView(state: MatchState, playerId: string): MatchState {
  return {
    ...state,
    roundActions: state.roundActions.filter((action) => action.playerId === playerId),
    roundBanked: state.roundBanked.filter((banked) => banked.playerId === playerId),
    players: state.players.map((player) => ({
      ...player,
      towers: player.id === playerId ? player.towers.map((tower) => ({ ...tower })) : [],
    })),
    history: state.history.map((round) => ({
      ...round,
      actions: round.actions.filter((action) => action.playerId === playerId),
      banked: round.banked.filter((banked) => banked.playerId === playerId),
      windShields: Object.fromEntries(
        Object.entries(round.windShields).filter(([id]) => id === playerId),
      ),
      fallenCounts: { ...round.fallenCounts },
    })),
  };
}

export function resolveRound(
  state: MatchState,
  actions: { playerId: string; action: PlayerAction }[],
  dice: [number, number],
): MatchState {
  if (state.status !== 'choice' || state.dice !== null) {
    throw new Error('There is no active round to resolve.');
  }
  const turnsByPlayer = new Map(state.roundTurnRolls.map((turn) => [turn.playerId, turn]));
  const actionsByPlayer = new Map<string, PlayerAction>();
  if (
    turnsByPlayer.size !== state.roundTurnRolls.length ||
    turnsByPlayer.size !== state.players.length ||
    actions.length !== state.players.length
  ) {
    throw new Error('Every player must choose and submit one action before the shared wind is rolled.');
  }
  for (const turn of state.roundTurnRolls) {
    if (!state.players.some((player) => player.id === turn.playerId)) {
      throw new Error('A turn belongs to a player who is not in this round.');
    }
  }
  for (const entry of actions) {
    if (!state.players.some((player) => player.id === entry.playerId) || actionsByPlayer.has(entry.playerId)) {
      throw new Error('Each player can submit only one action per round.');
    }
    actionsByPlayer.set(entry.playerId, entry.action);
  }
  for (const player of state.players) {
    const turn = turnsByPlayer.get(player.id);
    const action = actionsByPlayer.get(player.id);
    if (!turn || !action || turn.choice !== action.kind) {
      throw new Error(`A valid ${player.name} action is required before the wind is rolled.`);
    }
    const turnMode = turn.choice === 'build' ? 'build' : 'choose';
    if (!isLegalAction(player, action, turnMode, turn.die)) {
      throw new Error(`Invalid turn for ${player.name}.`);
    }
  }
  validateDice(dice);

  const players = state.players.map((item) => ({
    ...item,
    towers: item.towers.map((tower) => ({ ...tower })),
  }));
  let nextTowerId = state.nextTowerId;
  const roundTurnRolls = [...state.roundTurnRolls];
  const roundActions: RoundAction[] = [];
  const roundBanked = [...state.roundBanked];
  for (const player of players) {
    const action = actionsByPlayer.get(player.id)!;
    let placedElements = 0;
    const descriptions: string[] = [];
    if (action.kind === 'bank') {
      for (const towerId of action.towerIds) {
        const index = player.towers.findIndex((tower) => tower.id === towerId);
        const [tower] = player.towers.splice(index, 1);
        const points = towerPoints(tower!.height);
        player.score += points;
        player.bankedTowers += 1;
        roundBanked.push({ playerId: player.id, towerHeight: tower!.height, points });
        descriptions.push(`banked height ${tower!.height} (+${points})`);
      }
    } else {
      for (const placement of action.placements) {
        placedElements += placement.elements;
        if (placement.towerId === null) {
          const id = `tower-${nextTowerId++}`;
          const occupiedSlots = new Set(player.towers.map((tower) => tower.slot));
          const slot = placement.slot ?? firstAvailableTowerSlot(occupiedSlots);
          if (slot === null) throw new Error('There are no open tower slots.');
          player.towers.push({ id, height: placement.elements, slot });
        } else {
          const tower = player.towers.find((item) => item.id === placement.towerId)!;
          tower.height += placement.elements;
        }
      }
      if (placedElements > 0) {
        descriptions.push(`added ${placedElements} floor${placedElements === 1 ? '' : 's'}`);
      }
    }
    roundActions.push({ playerId: player.id, description: descriptions.join(' and ') || 'passed' });
  }

  const wind = dice[0] + dice[1];
  const resolution: RoundResolution = {
    round: state.round,
    turnRolls: roundTurnRolls,
    dice: [...dice],
    wind,
    windShields: Object.fromEntries(players.map((item) => [item.id, towerShield(item.towers.length)])),
    fallenCounts: Object.fromEntries(players.map((item) => [item.id, 0])),
    actions: roundActions,
    banked: roundBanked,
    pointsEarned: players.map((player) => ({
      playerId: player.id,
      points: roundBanked
        .filter((banked) => banked.playerId === player.id)
        .reduce((total, banked) => total + banked.points, 0),
    })),
    toppled: [],
  };

  const gameEnded = players.some((item) => item.score >= state.targetPoints);
  if (!gameEnded) {
    for (const item of players) {
      const shield = resolution.windShields[item.id];
      for (const tower of item.towers) {
        const limit = heightLimit(tower.height) + shield;
        if (wind >= limit) {
          tower.toppled = true;
          resolution.toppled.push({ playerId: item.id, towerId: tower.id, height: tower.height, limit });
          resolution.fallenCounts[item.id] = (resolution.fallenCounts[item.id] ?? 0) + 1;
        }
      }
    }
  }

  const highScore = Math.max(...players.map((item) => item.score));
  const winnerIds = gameEnded
    ? players.filter((item) => item.score === highScore).map((item) => item.id)
    : [];
  if (gameEnded) {
    for (const item of players) {
      if (winnerIds.includes(item.id)) item.roomWins += 1;
    }
  }

  return {
    ...state,
    dice: [...dice],
    status: gameEnded ? 'finished' : 'resolution',
    players,
    roundActions,
    roundBanked,
    history: [...state.history, resolution],
    winnerIds,
    nextTowerId,
  };
}

function validateDie(die: number): void {
  if (!Number.isInteger(die) || die < 1 || die > 6) {
    throw new Error('The die must show a whole number from 1 to 6.');
  }
}

function firstAvailableTowerSlot(occupiedSlots: Set<number>): number | null {
  for (let slot = 0; slot < MAX_TOWERS; slot += 1) {
    if (!occupiedSlots.has(slot)) return slot;
  }
  return null;
}

function validateDice(dice: [number, number]): void {
  if (dice.length !== 2 || dice.some((value) => !Number.isInteger(value) || value < 1 || value > 6)) {
    throw new Error('Each wind die must show a whole number from 1 to 6.');
  }
}
