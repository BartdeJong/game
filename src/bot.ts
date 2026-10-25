import { heightLimit, towerPoints, type Player, type PlayerAction } from './game.js';

export type BotTurnChoice =
  | { kind: 'build' }
  | { kind: 'bank'; towerId: string };

export function chooseBotTurnChoice(player: Player, targetPoints: number): BotTurnChoice {
  if (!Number.isInteger(targetPoints) || targetPoints < 1) {
    throw new Error('Robot target must be a positive whole number.');
  }
  const bankCandidate = player.towers
    .slice()
    .sort((left, right) => right.height - left.height)
    .find((tower) =>
      player.score + towerPoints(tower.height) >= targetPoints ||
      (tower.height >= 5 && heightLimit(tower.height) <= 8));
  return bankCandidate ? { kind: 'bank', towerId: bankCandidate.id } : { kind: 'build' };
}

export function chooseBotBuildAction(player: Player, turnDie: number): PlayerAction {
  if (!Number.isInteger(turnDie) || turnDie < 1 || turnDie > 6) {
    throw new Error('Robot die must be a whole number from 1 to 6.');
  }
  const towers = player.towers.map((tower) => ({ ...tower }));
  const placements = new Map<string, number>();
  for (let element = 0; element < turnDie; element += 1) {
    if (towers.length === 0) {
      placements.set('new-0', 1);
      towers.push({ id: '__new__', height: 1, slot: 0 });
      continue;
    }
    const shortest = towers.reduce((current, tower) => tower.height < current.height ? tower : current);
    if (shortest.id === '__new__') {
      const key = `new-${shortest.slot}`;
      placements.set(key, (placements.get(key) ?? 0) + 1);
    } else {
      placements.set(shortest.id, (placements.get(shortest.id) ?? 0) + 1);
    }
    shortest.height += 1;
  }
  return {
    kind: 'build',
    placements: Array.from(placements, ([key, elements]) => key.startsWith('new-')
      ? { towerId: null, elements, slot: Number(key.slice(4)) }
      : { towerId: key, elements }),
  };
}
