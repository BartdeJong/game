import {
  heightLimit,
  MAX_TOWERS,
  towerPoints,
  towerShield,
  type Player,
  type PlayerAction,
  type Tower,
} from './game.js';

export type BotTurnChoice =
  | { kind: 'build' }
  | { kind: 'bank'; towerIds: string[] };

interface BankCandidate {
  towerIds: string[];
  points: number;
  wins: boolean;
  value: number;
}

const WIND_SUM_COUNTS = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

export function chooseBotTurnChoice(player: Player, targetPoints: number, turnDie: number): BotTurnChoice {
  if (!Number.isInteger(targetPoints) || targetPoints < 1) {
    throw new Error('Robot target must be a positive whole number.');
  }
  validateBotDie(turnDie);
  const difficulty = player.botDifficulty ?? 'normal';
  if (difficulty === 'easy') return chooseEasyTurnChoice(player, targetPoints, turnDie);

  const buildAction = difficulty === 'hard'
    ? chooseHardBuildAction(player, turnDie)
    : chooseNormalBuildAction(player, turnDie);
  const buildValue = expectedSkylineValue(towersAfterBuild(player, buildAction));
  const bank = chooseBestBank(player, targetPoints, turnDie);
  if (!bank || (!bank.wins && bank.value <= buildValue)) return { kind: 'build' };
  return { kind: 'bank', towerIds: bank.towerIds };
}

export function chooseBotBuildAction(player: Player, turnDie: number): PlayerAction {
  validateBotDie(turnDie);
  const difficulty = player.botDifficulty ?? 'normal';
  if (difficulty === 'easy') return chooseEasyBuildAction(player, turnDie);
  return difficulty === 'hard'
    ? chooseHardBuildAction(player, turnDie)
    : chooseNormalBuildAction(player, turnDie);
}

function validateBotDie(turnDie: number): void {
  if (!Number.isInteger(turnDie) || turnDie < 1 || turnDie > 6) {
    throw new Error('Robot die must be a whole number from 1 to 6.');
  }
}

function chooseEasyTurnChoice(player: Player, targetPoints: number, turnDie: number): BotTurnChoice {
  const bankCandidates = player.towers.slice().sort((left, right) => right.height - left.height);
  const shouldBank = bankCandidates.some((tower) =>
    player.score + towerPoints(tower.height) >= targetPoints ||
    (tower.height >= 5 && heightLimit(tower.height) <= 8));
  return shouldBank
    ? { kind: 'bank', towerIds: bankCandidates.slice(0, turnDie).map((tower) => tower.id) }
    : { kind: 'build' };
}

function chooseEasyBuildAction(player: Player, turnDie: number): PlayerAction {
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

function chooseBestBank(player: Player, targetPoints: number, turnDie: number): BankCandidate | null {
  const maxTowers = Math.min(turnDie, player.towers.length);
  if (maxTowers === 0) return null;

  let best: BankCandidate | null = null;
  const selectedIds: string[] = [];
  const visit = (nextIndex: number): void => {
    if (selectedIds.length > 0) {
      const selected = new Set(selectedIds);
      const bankedTowers = player.towers.filter((tower) => selected.has(tower.id));
      const remainingTowers = player.towers.filter((tower) => !selected.has(tower.id));
      const points = bankedTowers.reduce((total, tower) => total + towerPoints(tower.height), 0);
      const wins = player.score + points >= targetPoints;
      const candidate: BankCandidate = {
        towerIds: [...selectedIds],
        points,
        wins,
        value: wins ? points : points + expectedSkylineValue(remainingTowers),
      };
      if (isBetterBankCandidate(candidate, best)) best = candidate;
    }
    if (selectedIds.length === maxTowers) return;
    for (let index = nextIndex; index < player.towers.length; index += 1) {
      selectedIds.push(player.towers[index]!.id);
      visit(index + 1);
      selectedIds.pop();
    }
  };
  visit(0);
  return best;
}

function isBetterBankCandidate(candidate: BankCandidate, current: BankCandidate | null): boolean {
  if (!current) return true;
  if (candidate.wins !== current.wins) return candidate.wins;
  if (candidate.wins && candidate.points !== current.points) return candidate.points > current.points;
  if (Math.abs(candidate.value - current.value) > 1e-9) return candidate.value > current.value;
  if (candidate.towerIds.length !== current.towerIds.length) {
    return candidate.towerIds.length < current.towerIds.length;
  }
  return candidate.points > current.points;
}

function chooseNormalBuildAction(player: Player, turnDie: number): PlayerAction {
  const towers = player.towers.map((tower) => ({ ...tower }));
  const placements = new Map<string, number>();
  const newTowerSlots = new Map<string, number>();
  let newTowerCreated = false;
  for (let floor = 0; floor < turnDie; floor += 1) {
    let best: { towerIndex: number; value: number } | null = null;
    for (let index = 0; index < towers.length; index += 1) {
      const candidateTowers = towers.map((tower) => ({ ...tower }));
      candidateTowers[index]!.height += 1;
      const value = expectedSkylineValue(candidateTowers);
      if (!best || value > best.value + 1e-9) best = { towerIndex: index, value };
    }

    const slot = !newTowerCreated && towers.length < MAX_TOWERS ? firstFreeSlot(towers) : null;
    if (slot !== null) {
      const candidateTowers = [
        ...towers.map((tower) => ({ ...tower })),
        { id: `__bot_new_${slot}`, height: 1, slot },
      ];
      const value = expectedSkylineValue(candidateTowers);
      if (!best || value > best.value + 1e-9) {
        const id = candidateTowers[candidateTowers.length - 1]!.id;
        best = { towerIndex: towers.length, value };
        newTowerSlots.set(id, slot);
      }
    }
    if (!best) throw new Error('Robot could not find a legal building target.');

    if (best.towerIndex === towers.length) {
      if (slot === null) throw new Error('Robot selected a new tower without an available slot.');
      const id = uniqueBotTowerId(towers, slot);
      towers.push({ id, height: 1, slot });
      placements.set(id, 1);
      newTowerSlots.set(id, slot);
      newTowerCreated = true;
    } else {
      const tower = towers[best.towerIndex]!;
      tower.height += 1;
      placements.set(tower.id, (placements.get(tower.id) ?? 0) + 1);
    }
  }
  return placementsToAction(placements, newTowerSlots);
}

function chooseHardBuildAction(player: Player, turnDie: number): PlayerAction {
  const newSlot = player.towers.length < MAX_TOWERS ? firstFreeSlot(player.towers) : null;
  const targetCount = player.towers.length + (newSlot === null ? 0 : 1);
  const allocations = Array<number>(targetCount).fill(0);
  let bestAction: PlayerAction | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  let bestFloors = -1;

  const evaluate = (remaining: number): void => {
    const floors = turnDie - remaining;
    if (floors === 0) return;
    const placements = new Map<string, number>();
    const newTowerSlots = new Map<string, number>();
    for (let index = 0; index < player.towers.length; index += 1) {
      const tower = player.towers[index]!;
      if (allocations[index]! > 0) placements.set(tower.id, allocations[index]!);
    }
    if (newSlot !== null) {
      const newFloors = allocations[player.towers.length]!;
      if (newFloors > 0) {
        const id = uniqueBotTowerId(player.towers, newSlot);
        placements.set(id, newFloors);
        newTowerSlots.set(id, newSlot);
      }
    }
    const action = placementsToAction(placements, newTowerSlots);
    const value = expectedSkylineValue(towersAfterBuild(player, action));
    if (value > bestValue + 1e-9 || (Math.abs(value - bestValue) <= 1e-9 && floors > bestFloors)) {
      bestAction = action;
      bestValue = value;
      bestFloors = floors;
    }
  };

  const enumerate = (index: number, remaining: number): void => {
    if (index === targetCount) {
      evaluate(remaining);
      return;
    }
    for (let amount = 0; amount <= remaining; amount += 1) {
      allocations[index] = amount;
      enumerate(index + 1, remaining - amount);
    }
  };
  enumerate(0, turnDie);
  if (!bestAction) throw new Error('Robot could not find a legal building target.');
  return bestAction;
}

function placementsToAction(
  placements: Map<string, number>,
  newTowerSlots: Map<string, number>,
): PlayerAction {
  return {
    kind: 'build',
    placements: Array.from(placements, ([id, elements]) => {
      const slot = newTowerSlots.get(id);
      return slot === undefined
        ? { towerId: id, elements }
        : { towerId: null, elements, slot };
    }),
  };
}

function towersAfterBuild(player: Player, action: PlayerAction): Tower[] {
  if (action.kind !== 'build') throw new Error('Robot expected a building action.');
  const towers = player.towers.map((tower) => ({ ...tower }));
  for (const placement of action.placements) {
    if (placement.towerId === null) {
      const slot = placement.slot ?? firstFreeSlot(towers);
      if (slot === null) throw new Error('Robot build has no open tower slot.');
      towers.push({ id: `__bot_simulation_${slot}`, height: placement.elements, slot });
    } else {
      const tower = towers.find((item) => item.id === placement.towerId);
      if (!tower) throw new Error(`Robot build references unknown tower ${placement.towerId}.`);
      tower.height += placement.elements;
    }
  }
  return towers;
}

function firstFreeSlot(towers: readonly Tower[]): number | null {
  const occupied = new Set(towers.map((tower, index) => tower.slot ?? index));
  for (let slot = 0; slot < MAX_TOWERS; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return null;
}

function uniqueBotTowerId(towers: readonly Tower[], slot: number): string {
  let id = `__bot_new_${slot}`;
  while (towers.some((tower) => tower.id === id)) id = `_${id}`;
  return id;
}

function expectedSkylineValue(towers: readonly Tower[]): number {
  const shield = towerShield(towers.length);
  return towers.reduce((total, tower) =>
    total + towerPoints(tower.height) * (1 - toppleProbability(tower.height, shield)), 0);
}

function toppleProbability(height: number, shield: number): number {
  const toppleAt = heightLimit(height) + shield;
  let toppledRolls = 0;
  for (let wind = 2; wind <= 12; wind += 1) {
    if (wind >= toppleAt) toppledRolls += WIND_SUM_COUNTS[wind - 2]!;
  }
  return toppledRolls / 36;
}
