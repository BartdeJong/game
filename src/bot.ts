import { towerPoints, type Player, type PlayerAction, type Tower } from './game.js';

function tallest(towers: Tower[]): Tower {
  return towers.reduce((current, tower) => tower.height > current.height ? tower : current);
}

export function chooseBotAction(player: Player, targetPoints: number): PlayerAction {
  if (!Number.isInteger(targetPoints) || targetPoints < 1) {
    throw new Error('Robot target must be a positive whole number.');
  }
  if (player.towers.length === 0) return { kind: 'new' };

  const candidate = tallest(player.towers);
  if (player.score + towerPoints(candidate.height) >= targetPoints || candidate.height >= 4) {
    return { kind: 'bank', towerId: candidate.id };
  }
  return { kind: 'build', towerId: candidate.id };
}
