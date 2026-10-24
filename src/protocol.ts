import {
  MAX_WIN_POINTS,
  MIN_WIN_POINTS,
  type MatchState,
  type PlayerAction,
} from './game';

export type PeerMessage =
  | { type: 'join'; playerId: string; name: string }
  | { type: 'action'; playerId: string; action: PlayerAction }
  | { type: 'state'; state: MatchState; submittedCount: number; playerId: string }
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
    typeof value.playerId === 'string'
  ) {
    return {
      type: 'state',
      state: value.state,
      submittedCount: value.submittedCount,
      playerId: value.playerId,
    };
  }
  if (value.type === 'error' && 'message' in value && typeof value.message === 'string') {
    return { type: 'error', message: value.message };
  }
  if (value.type === 'join' && 'playerId' in value && 'name' in value) {
    if (typeof value.playerId !== 'string' || typeof value.name !== 'string') {
      throw new Error('Received an invalid join request.');
    }
    return { type: 'join', playerId: value.playerId, name: value.name };
  }
  if (value.type === 'action' && 'playerId' in value && 'action' in value) {
    if (typeof value.playerId !== 'string') throw new Error('Received an invalid player action.');
    const action = value.action;
    if (
      typeof action !== 'object' ||
      action === null ||
      !('kind' in action) ||
      (action.kind !== 'new' && action.kind !== 'build' && action.kind !== 'bank') ||
      ((action.kind === 'build' || action.kind === 'bank') &&
        (!('towerId' in action) || typeof action.towerId !== 'string'))
    ) {
      throw new Error('Received an invalid player action.');
    }
    if (action.kind === 'new') {
      return { type: 'action', playerId: value.playerId, action: { kind: 'new' } };
    }
    if ('towerId' in action && typeof action.towerId === 'string') {
      return {
        type: 'action',
        playerId: value.playerId,
        action: { kind: action.kind, towerId: action.towerId },
      };
    }
    throw new Error('Received an invalid player action.');
  }
  throw new Error('Received an unsupported game message.');
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
    !('dice' in value)
  ) {
    return false;
  }
  if (
    !value.history.every((round) => isRoundHistoryEntry(round)) ||
    value.players.some((player) => !isPlayerState(player))
  ) {
    return false;
  }
  if (value.status === 'lobby' || value.status === 'choice') return value.dice === null;
  return Array.isArray(value.dice) &&
    value.dice.length === 2 &&
    value.dice.every((die) => typeof die === 'number' && Number.isInteger(die) && die >= 1 && die <= 6);
}

function isPlayerState(value: unknown): boolean {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'roomWins' in value &&
    typeof value.roomWins === 'number' &&
    Number.isInteger(value.roomWins) &&
    value.roomWins >= 0;
}

function isRoundHistoryEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('fallenCounts' in value)) return false;
  const counts = value.fallenCounts;
  return typeof counts === 'object' &&
    counts !== null &&
    !Array.isArray(counts) &&
    Object.values(counts).every((count) =>
      typeof count === 'number' && Number.isInteger(count) && count >= 0);
}
