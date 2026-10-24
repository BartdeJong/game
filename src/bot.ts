import { heightLimit, type Player, type PlayerAction, type Tower } from './game.js';

function tallest(towers: Tower[]): Tower {
  return towers.reduce((current, tower) => tower.height > current.height ? tower : current);
}

export function chooseBotAction(player: Player, wind: number): PlayerAction {
  if (!Number.isInteger(wind) || wind < 2 || wind > 12) {
    throw new Error('Robot wind must be a valid two-dice total.');
  }
  if (player.towers.length === 0) return { kind: 'new' };

  const endangered = player.towers.filter((tower) => wind >= heightLimit(tower.height));
  if (player.bankedTowers >= 2) return { kind: 'bank', towerId: tallest(player.towers).id };
  if (endangered.length > 0) return { kind: 'bank', towerId: tallest(endangered).id };

  const safeBuilds = player.towers.filter((tower) => wind < heightLimit(tower.height + 1));
  if (safeBuilds.length > 0) {
    const candidate = tallest(safeBuilds);
    if (candidate.height >= 5) return { kind: 'bank', towerId: candidate.id };
    return { kind: 'build', towerId: candidate.id };
  }
  if (wind < heightLimit(1)) return { kind: 'new' };
  return { kind: 'bank', towerId: tallest(player.towers).id };
}
