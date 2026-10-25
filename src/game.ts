export const MAX_PLAYERS = 5;
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

export interface Placement {
  towerId: string | null;
  elements: number;
  slot?: number;
}

export type PlayerAction =
  | { kind: 'build'; placements: Placement[] }
  | { kind: 'bank'; towerId: string };

export interface RoundAction {
  playerId: string;
  description: string;
}

export interface RoundResolution {
  round: number;
  turnRolls: { playerId: string; choice: 'build' | 'bank'; die: number | null }[];
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
  turnDie: number | null;
  turnMode: 'choose' | 'build' | null;
  currentPlayerIndex: number;
  roundTurnRolls: { playerId: string; choice: 'build' | 'bank'; die: number | null }[];
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
    dice: null,
    turnDie: null,
    turnMode: null,
    currentPlayerIndex: 0,
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
  return height >= 7 ? 6 : 13 - height;
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
    return turnMode === 'choose' &&
      turnDie === null &&
      player.towers.some((tower) => tower.id === action.towerId);
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
    throw new Error('The room needs 2–5 players before the game can start.');
  }
  validateTargetPoints(state.targetPoints);
  return {
    ...state,
    status: 'choice',
    round: 1,
    dice: null,
    turnDie: null,
    turnMode: 'choose',
    currentPlayerIndex: 0,
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

export function beginBuildingTurn(state: MatchState, turnDie: number): MatchState {
  if (state.status !== 'choice' || state.turnMode !== 'choose' || state.turnDie !== null) {
    throw new Error('Choose building before rolling the die.');
  }
  validateDie(turnDie);
  return { ...state, turnMode: 'build', turnDie };
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
    turnDie: null,
    turnMode: null,
    currentPlayerIndex: 0,
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
    turnDie: null,
    turnMode: 'choose',
    currentPlayerIndex: 0,
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
    throw new Error('The next turn can only start after the previous turn resolves.');
  }
  const windResolved = state.dice !== null;
  return {
    ...state,
    status: 'choice',
    round: windResolved ? state.round + 1 : state.round,
    dice: null,
    turnDie: null,
    turnMode: 'choose',
    currentPlayerIndex: windResolved ? 0 : (state.currentPlayerIndex + 1) % state.players.length,
    roundTurnRolls: windResolved ? [] : state.roundTurnRolls,
    roundActions: windResolved ? [] : state.roundActions,
    roundBanked: windResolved ? [] : state.roundBanked,
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
      fallenCounts: { ...round.fallenCounts },
    })),
  };
}

export function resolveRound(
  state: MatchState,
  action: PlayerAction,
  dice: [number, number] | null,
): MatchState {
  if (state.status !== 'choice' || state.dice !== null || state.turnMode === null) {
    throw new Error('There is no active turn to resolve.');
  }
  const player = state.players[state.currentPlayerIndex];
  if (!player || !isLegalAction(player, action, state.turnMode, state.turnDie)) {
    throw new Error(`Invalid turn for ${player?.name ?? 'the active player'}.`);
  }
  const actedPlayerIds = new Set(state.roundTurnRolls.map((turn) => turn.playerId));
  if (
    actedPlayerIds.size !== state.roundTurnRolls.length ||
    actedPlayerIds.has(player.id) ||
    state.players.find((item) => !actedPlayerIds.has(item.id))?.id !== player.id
  ) {
    throw new Error('Players must take one turn each, in order, before the wind is rolled.');
  }
  const finalPlayerTurn = state.players.every((item) => item.id === player.id || actedPlayerIds.has(item.id));
  if (finalPlayerTurn !== (dice !== null)) {
    throw new Error(finalPlayerTurn
      ? 'The shared wind must be rolled after every player has taken a turn.'
      : 'The shared wind cannot be rolled until every player has taken a turn.');
  }
  if (dice) validateDice(dice);

  const players = state.players.map((item) => ({
    ...item,
    towers: item.towers.map((tower) => ({ ...tower })),
  }));
  const activePlayer = players[state.currentPlayerIndex]!;
  let nextTowerId = state.nextTowerId;
  const roundTurnRolls = [...state.roundTurnRolls, {
    playerId: activePlayer.id,
    choice: action.kind,
    die: action.kind === 'build' ? state.turnDie : null,
  }];
  const roundActions = [...state.roundActions];
  const roundBanked = [...state.roundBanked];
  let bankedEntry: { playerId: string; towerHeight: number; points: number } | null = null;
  if (action.kind === 'bank') {
    const index = activePlayer.towers.findIndex((tower) => tower.id === action.towerId);
    const [tower] = activePlayer.towers.splice(index, 1);
    const points = towerPoints(tower!.height);
    activePlayer.score += points;
    activePlayer.bankedTowers += 1;
    bankedEntry = { playerId: activePlayer.id, towerHeight: tower!.height, points };
    roundBanked.push(bankedEntry);
  }

  let placedElements = 0;
  if (action.kind === 'build') {
    for (const placement of action.placements) {
      placedElements += placement.elements;
      if (placement.towerId === null) {
        const id = `tower-${nextTowerId++}`;
        const occupiedSlots = new Set(activePlayer.towers.map((tower) => tower.slot));
        const slot = placement.slot ?? firstAvailableTowerSlot(occupiedSlots);
        if (slot === null) throw new Error('There are no open tower slots.');
        activePlayer.towers.push({ id, height: placement.elements, slot });
      } else {
        const tower = activePlayer.towers.find((item) => item.id === placement.towerId)!;
        tower.height += placement.elements;
      }
    }
  }

  const descriptions: string[] = [];
  if (placedElements > 0) {
    descriptions.push(`added ${placedElements} floor${placedElements === 1 ? '' : 's'}`);
  }
  if (action.kind === 'bank' && bankedEntry) {
    descriptions.push(`banked height ${bankedEntry.towerHeight} (+${bankedEntry.points})`);
  }
  roundActions.push({
    playerId: activePlayer.id,
    description: descriptions.join(' and ') || 'passed',
  });

  if (!finalPlayerTurn) {
    return {
      ...state,
      dice: null,
      turnDie: null,
      turnMode: null,
      status: 'resolution',
      players,
      roundTurnRolls,
      roundActions,
      roundBanked,
      nextTowerId,
    };
  }

  const windDice = dice!;
  const wind = windDice[0] + windDice[1];
  const resolution: RoundResolution = {
    round: state.round,
    turnRolls: roundTurnRolls,
    dice: [...windDice],
    wind,
    fallenCounts: Object.fromEntries(players.map((item) => [item.id, 0])),
    actions: roundActions,
    banked: roundBanked,
    toppled: [],
  };

  for (const item of players) {
    const standing: Tower[] = [];
    const shield = towerShield(item.towers.length);
    for (const tower of item.towers) {
      const limit = heightLimit(tower.height) + shield;
      if (wind >= limit) {
        resolution.toppled.push({ playerId: item.id, towerId: tower.id, height: tower.height, limit });
        resolution.fallenCounts[item.id] = (resolution.fallenCounts[item.id] ?? 0) + 1;
      } else {
        standing.push(tower);
      }
    }
    item.towers = standing;
  }

  const gameEnded = players.some((item) => item.score >= state.targetPoints);
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
    dice: [...windDice],
    turnDie: null,
    turnMode: null,
    status: gameEnded ? 'finished' : 'resolution',
    players,
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
