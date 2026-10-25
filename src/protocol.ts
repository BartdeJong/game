import {
  MAX_TOWERS,
  MAX_WIN_POINTS,
  MIN_WIN_POINTS,
  type MatchState,
  type PlayerAction,
} from './game.js';

export type PeerMessage =
  | { type: 'join'; playerId: string; name: string; resumeToken?: string }
  | { type: 'build'; playerId: string }
  | { type: 'action'; playerId: string; action: PlayerAction }
  | { type: 'state'; state: MatchState; submittedCount: number; playerId: string; resumeToken?: string; isSubmitted?: boolean }
  | { type: 'error'; message: string };

export function parseMessage(data: string): PeerMessage {
  const value: unknown = JSON.parse(data);
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('Received an invalid game message.');
  }
  if (
    value.type === 'state' &&
    'state' in value &&
    'submittedCount' in value &&
    'playerId' in value &&
    isMatchState(value.state) &&
    typeof value.submittedCount === 'number' &&
    value.submittedCount >= 0 &&
    typeof value.playerId === 'string' &&
    (!('resumeToken' in value) || typeof value.resumeToken === 'string') &&
    (!('isSubmitted' in value) || typeof value.isSubmitted === 'boolean')
  ) {
    return {
      type: 'state',
      state: value.state,
      submittedCount: value.submittedCount,
      playerId: value.playerId,
      ...('resumeToken' in value && typeof value.resumeToken === 'string' ? { resumeToken: value.resumeToken } : {}),
      ...('isSubmitted' in value && typeof value.isSubmitted === 'boolean' ? { isSubmitted: value.isSubmitted } : {}),
    };
  }
  if (value.type === 'error' && 'message' in value && typeof value.message === 'string') {
    return { type: 'error', message: value.message };
  }
  if (value.type === 'join' && 'playerId' in value && 'name' in value) {
    if (
      typeof value.playerId !== 'string' ||
      typeof value.name !== 'string' ||
      ('resumeToken' in value && typeof value.resumeToken !== 'string')
    ) {
      throw new Error('Received an invalid join request.');
    }
    return {
      type: 'join',
      playerId: value.playerId,
      name: value.name,
      ...('resumeToken' in value && typeof value.resumeToken === 'string' ? { resumeToken: value.resumeToken } : {}),
    };
  }
  if (value.type === 'build' && 'playerId' in value && typeof value.playerId === 'string') {
    return { type: 'build', playerId: value.playerId };
  }
  if (value.type === 'action' && 'playerId' in value && 'action' in value) {
    if (typeof value.playerId !== 'string' || !isPlayerAction(value.action)) {
      throw new Error('Received an invalid player action.');
    }
    return { type: 'action', playerId: value.playerId, action: value.action };
  }
  throw new Error('Received an unsupported game message.');
}

function isPlayerAction(value: unknown): value is PlayerAction {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'bank') {
    return 'towerId' in value && typeof value.towerId === 'string';
  }
  if (value.kind !== 'build' || !('placements' in value) || !Array.isArray(value.placements)) return false;
  return value.placements.every((placement) =>
    typeof placement === 'object' &&
    placement !== null &&
    'towerId' in placement &&
    (placement.towerId === null || typeof placement.towerId === 'string') &&
    'elements' in placement &&
    typeof placement.elements === 'number' &&
    Number.isInteger(placement.elements) &&
    placement.elements >= 1 &&
    (!('slot' in placement) ||
      (typeof placement.slot === 'number' &&
        Number.isInteger(placement.slot) &&
        placement.slot >= 0 &&
        placement.slot < MAX_TOWERS)));
}

function isMatchState(value: unknown): value is MatchState {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('status' in value) ||
    (value.status !== 'lobby' &&
      value.status !== 'choice' &&
      value.status !== 'resolution' &&
      value.status !== 'finished') ||
    !('round' in value) ||
    typeof value.round !== 'number' ||
    !('targetPoints' in value) ||
    typeof value.targetPoints !== 'number' ||
    !Number.isInteger(value.targetPoints) ||
    value.targetPoints < MIN_WIN_POINTS ||
    value.targetPoints > MAX_WIN_POINTS ||
    !('players' in value) ||
    !Array.isArray(value.players) ||
    !('history' in value) ||
    !Array.isArray(value.history) ||
    !('winnerIds' in value) ||
    !Array.isArray(value.winnerIds) ||
    !('nextTowerId' in value) ||
    typeof value.nextTowerId !== 'number' ||
    !('currentPlayerIndex' in value) ||
    typeof value.currentPlayerIndex !== 'number' ||
    !Number.isInteger(value.currentPlayerIndex) ||
    !('roundTurnRolls' in value) ||
    !Array.isArray(value.roundTurnRolls) ||
    !('roundActions' in value) ||
    !Array.isArray(value.roundActions) ||
    !('roundBanked' in value) ||
    !Array.isArray(value.roundBanked) ||
    !('turnDie' in value) ||
    (value.turnDie !== null &&
      (typeof value.turnDie !== 'number' ||
        !Number.isInteger(value.turnDie) ||
        value.turnDie < 1 ||
        value.turnDie > 6)) ||
    !('turnMode' in value) ||
    (value.turnMode !== null && value.turnMode !== 'choose' && value.turnMode !== 'build') ||
    !('dice' in value)
  ) {
    return false;
  }
  if (
    !value.history.every((round) => isRoundHistoryEntry(round)) ||
    value.players.some((player) => !isPlayerState(player)) ||
    value.currentPlayerIndex < 0 ||
    (value.players.length > 0 && value.currentPlayerIndex >= value.players.length)
  ) {
    return false;
  }
  if (value.status === 'lobby') return value.dice === null && value.turnDie === null && value.turnMode === null;
  if (value.status === 'choice') {
    return value.dice === null &&
      ((value.turnMode === 'choose' && value.turnDie === null) ||
        (value.turnMode === 'build' && value.turnDie !== null));
  }
  if (value.status === 'resolution' && value.dice === null) {
    return value.turnDie === null && value.turnMode === null;
  }
  return value.turnDie === null &&
    value.turnMode === null &&
    Array.isArray(value.dice) &&
    value.dice.length === 2 &&
    value.dice.every((die) => typeof die === 'number' && Number.isInteger(die) && die >= 1 && die <= 6);
}

function isPlayerState(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('roomWins' in value) ||
    typeof value.roomWins !== 'number' ||
    !Number.isInteger(value.roomWins) ||
    value.roomWins < 0 ||
    !('towers' in value) ||
    !Array.isArray(value.towers) ||
    value.towers.length > MAX_TOWERS
  ) return false;
  const slots = new Set<number>();
  return value.towers.every((tower, index) => {
    if (
      typeof tower !== 'object' ||
      tower === null ||
      !('id' in tower) ||
      typeof tower.id !== 'string' ||
      !('height' in tower) ||
      typeof tower.height !== 'number' ||
      !Number.isInteger(tower.height) ||
      tower.height < 1
    ) return false;
    const slot = 'slot' in tower ? tower.slot : index;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= MAX_TOWERS || slots.has(slot)) {
      return false;
    }
    slots.add(slot);
    return true;
  });
}

function isRoundHistoryEntry(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('fallenCounts' in value) ||
    !('toppled' in value) ||
    !Array.isArray(value.toppled)
  ) return false;
  const counts = value.fallenCounts;
  return typeof counts === 'object' &&
    counts !== null &&
    !Array.isArray(counts) &&
    Object.values(counts).every((count) =>
      typeof count === 'number' && Number.isInteger(count) && count >= 0);
}
