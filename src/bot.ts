import {
  heightLimit,
  DEFAULT_WIN_POINTS,
  DEFAULT_EXTREME_SEARCH_DEPTH,
  isExtremeSearchDepth,
  MAX_TOWERS,
  towerPoints,
  towerShield,
  type Player,
  type PlayerAction,
  type Tower,
} from './game.js';

export type BotTurnChoice =
  | { kind: 'build'; action?: PlayerAction }
  | { kind: 'bank'; towerIds: string[] };

interface BankCandidate {
  towerIds: string[];
  points: number;
  wins: boolean;
  value: number;
}

interface StrategicValue {
  winProbability: number;
  points: number;
}

export interface BotOpponent {
  player: Player;
  turnDie: number;
}

export interface BotDecisionRequest {
  player: Player;
  targetPoints: number;
  turnDie: number;
  opponents: BotOpponent[];
}

export type BotDecisionResponse =
  | { action: PlayerAction }
  | { error: string };

const WIND_SUM_COUNTS = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

export function chooseBotTurnChoice(
  player: Player,
  targetPoints: number,
  turnDie: number,
  opponents: readonly BotOpponent[] = [],
): BotTurnChoice {
  if (!Number.isInteger(targetPoints) || targetPoints < 1) {
    throw new Error('Robot target must be a positive whole number.');
  }
  validateBotDie(turnDie);
  const difficulty = player.botDifficulty ?? 'normal';
  if (difficulty === 'easy') return chooseEasyTurnChoice(player, targetPoints, turnDie);
  if (difficulty === 'ultra') {
    const action = chooseUltraAction(player, targetPoints, turnDie);
    return action.kind === 'bank'
      ? { kind: 'bank', towerIds: action.towerIds }
      : { kind: 'build' };
  }
  if (difficulty === 'extreme') {
    const action = chooseExtremeAction(player, targetPoints, turnDie, opponents);
    return action.kind === 'bank'
      ? { kind: 'bank', towerIds: action.towerIds }
      : { kind: 'build', action };
  }

  const buildAction = difficulty === 'hard'
    ? chooseHardBuildAction(player, turnDie)
    : chooseNormalBuildAction(player, turnDie);
  const buildValue = expectedSkylineValue(towersAfterBuild(player, buildAction));
  const bank = chooseBestBank(player, targetPoints, turnDie);
  if (!bank || (!bank.wins && bank.value <= buildValue)) return { kind: 'build' };
  return { kind: 'bank', towerIds: bank.towerIds };
}

export function chooseBotBuildAction(
  player: Player,
  turnDie: number,
  targetPoints = DEFAULT_WIN_POINTS,
  opponents: readonly BotOpponent[] = [],
): PlayerAction {
  validateBotDie(turnDie);
  const difficulty = player.botDifficulty ?? 'normal';
  if (difficulty === 'easy') return chooseEasyBuildAction(player, turnDie);
  if (difficulty === 'ultra') return chooseUltraAction(player, targetPoints, turnDie, false);
  if (difficulty === 'extreme') return chooseExtremeAction(player, targetPoints, turnDie, opponents, false);
  return difficulty === 'hard'
    ? chooseHardBuildAction(player, turnDie)
    : chooseNormalBuildAction(player, turnDie);
}

export function chooseBotAction(
  player: Player,
  targetPoints: number,
  turnDie: number,
  opponents: readonly BotOpponent[] = [],
): PlayerAction {
  const choice = chooseBotTurnChoice(player, targetPoints, turnDie, opponents);
  if (choice.kind === 'bank') return choice;
  return choice.action ?? chooseBotBuildAction(player, turnDie, targetPoints, opponents);
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

function chooseUltraAction(
  player: Player,
  targetPoints: number,
  turnDie: number,
  includeBanking = true,
): PlayerAction {
  const futureCache = new Map<string, StrategicValue>();
  let bestAction: PlayerAction | null = null;
  let bestValue: StrategicValue | null = null;
  let bestFloors = -1;

  const consider = (action: PlayerAction): void => {
    const value = evaluateUltraAction(player, action, targetPoints, futureCache);
    const floors = action.kind === 'build'
      ? action.placements.reduce((total, placement) => total + placement.elements, 0)
      : -1;
    if (
      !bestValue ||
      value.winProbability > bestValue.winProbability + 1e-9 ||
      (Math.abs(value.winProbability - bestValue.winProbability) <= 1e-9 &&
        value.points > bestValue.points + 1e-9) ||
      (Math.abs(value.winProbability - bestValue.winProbability) <= 1e-9 &&
        Math.abs(value.points - bestValue.points) <= 1e-9 &&
        action.kind === 'build' &&
        floors > bestFloors)
    ) {
      bestAction = action;
      bestValue = value;
      bestFloors = floors;
    }
  };

  for (const action of enumerateBuildActions(player, turnDie)) consider(action);
  if (includeBanking) {
    for (const action of enumerateBankActions(player, turnDie)) consider(action);
  }
  if (!bestAction) throw new Error('Robot could not find a legal turn action.');
  return bestAction;
}

function evaluateUltraAction(
  player: Player,
  action: PlayerAction,
  targetPoints: number,
  futureCache: Map<string, StrategicValue>,
): StrategicValue {
  let bankedPoints = 0;
  let towers: Tower[];
  if (action.kind === 'bank') {
    const selected = new Set(action.towerIds);
    towers = player.towers.filter((tower) => !selected.has(tower.id)).map((tower) => ({ ...tower }));
    bankedPoints = player.towers
      .filter((tower) => selected.has(tower.id))
      .reduce((total, tower) => total + towerPoints(tower.height), 0);
    if (player.score + bankedPoints >= targetPoints) {
      return { winProbability: 1, points: bankedPoints };
    }
  } else {
    towers = towersAfterBuild(player, action);
  }

  const shield = towerShield(towers.length);
  let winProbability = 0;
  let futurePoints = 0;
  for (let wind = 2; wind <= 12; wind += 1) {
    const frequency = WIND_SUM_COUNTS[wind - 2]!;
    const survivors = towers
      .filter((tower) => wind < heightLimit(tower.height) + shield)
      .map((tower) => ({ ...tower }));
    const future = evaluateNextTurn(player, survivors, player.score + bankedPoints, targetPoints, futureCache);
    winProbability += frequency * future.winProbability;
    futurePoints += frequency * future.points;
  }
  return {
    winProbability: winProbability / 36,
    points: bankedPoints + futurePoints / 36,
  };
}

function chooseExtremeAction(
  player: Player,
  targetPoints: number,
  turnDie: number,
  opponents: readonly BotOpponent[],
  includeBanking = true,
): PlayerAction {
  const opponentWinningScore = includeBanking
    ? predictImmediateOpponentWin(player, opponents, targetPoints)
    : null;
  if (opponentWinningScore !== null) {
    let bestBank: PlayerAction | null = null;
    let bestPoints = -1;
    for (const action of enumerateBankActions(player, turnDie)) {
      if (action.kind !== 'bank') continue;
      const points = player.towers
        .filter((tower) => action.towerIds.includes(tower.id))
        .reduce((total, tower) => total + towerPoints(tower.height), 0);
      if (points > bestPoints) {
        bestBank = action;
        bestPoints = points;
      }
    }
    return bestBank ?? chooseHardBuildAction(player, turnDie);
  }

  const maxDepth = player.extremeSearchDepth ?? DEFAULT_EXTREME_SEARCH_DEPTH;
  if (!isExtremeSearchDepth(maxDepth)) {
    throw new Error('Extreme Robot search depth must be a whole number from 1 to 50.');
  }
  let bestAction = chooseUltraAction(player, targetPoints, turnDie, includeBanking);
  const actions = enumerateBuildActions(player, turnDie);
  if (includeBanking) {
    actions.push(...enumerateBankActions(player, turnDie));
  }

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const extremeCache = new Map<string, StrategicValue>();
    const windCache = new Map<string, StrategicValue>();
    const futureCache = new Map<string, StrategicValue>();
    let iterationBestAction: PlayerAction | null = null;
    let iterationBestValue: StrategicValue | null = null;
    let iterationBestFloors = -1;

    for (const action of actions) {
      const value = evaluateExtremeAction(
        player,
        action,
        targetPoints,
        depth,
        extremeCache,
        windCache,
        futureCache,
      );
      const floors = action.kind === 'build'
        ? action.placements.reduce((total, placement) => total + placement.elements, 0)
        : -1;
      if (
        !iterationBestValue ||
        isBetterStrategicValue(value, iterationBestValue) ||
        (!isBetterStrategicValue(iterationBestValue, value) &&
          action.kind === 'build' &&
          floors > iterationBestFloors)
      ) {
        iterationBestAction = action;
        iterationBestValue = value;
        iterationBestFloors = floors;
      }
    }

    if (iterationBestAction) bestAction = iterationBestAction;
  }
  return bestAction;
}

function predictImmediateOpponentWin(
  player: Player,
  opponents: readonly BotOpponent[],
  targetPoints: number,
): number | null {
  let highestWinningScore: number | null = null;
  for (const opponent of opponents) {
    if (opponent.player.id === player.id) continue;
    validateBotDie(opponent.turnDie);
    const bank = chooseBestBank(opponent.player, targetPoints, opponent.turnDie);
    if (bank?.wins) {
      const score = opponent.player.score + bank.points;
      highestWinningScore = Math.max(highestWinningScore ?? score, score);
    }
  }
  return highestWinningScore;
}

function evaluateExtremeAction(
  player: Player,
  action: PlayerAction,
  targetPoints: number,
  depth: number,
  extremeCache: Map<string, StrategicValue>,
  windCache: Map<string, StrategicValue>,
  futureCache: Map<string, StrategicValue>,
): StrategicValue {
  let bankedPoints = 0;
  let towers: Tower[];
  if (action.kind === 'bank') {
    const selected = new Set(action.towerIds);
    towers = player.towers.filter((tower) => !selected.has(tower.id)).map((tower) => ({ ...tower }));
    bankedPoints = player.towers
      .filter((tower) => selected.has(tower.id))
      .reduce((total, tower) => total + towerPoints(tower.height), 0);
    if (player.score + bankedPoints >= targetPoints) {
      return { winProbability: 1, points: bankedPoints };
    }
  } else {
    towers = towersAfterBuild(player, action);
  }

  const shield = towerShield(towers.length);
  let winProbability = 0;
  let points = 0;
  for (let wind = 2; wind <= 12; wind += 1) {
    const frequency = WIND_SUM_COUNTS[wind - 2]!;
    const survivors = towers
      .filter((tower) => wind < heightLimit(tower.height) + shield)
      .map((tower) => ({ ...tower }));
    const future = evaluateExtremeAfterWind(
      player,
      survivors,
      player.score + bankedPoints,
      targetPoints,
      depth,
      extremeCache,
      windCache,
      futureCache,
    );
    winProbability += frequency * future.winProbability;
    points += frequency * future.points;
  }
  return {
    winProbability: winProbability / 36,
    points: bankedPoints + points / 36,
  };
}

function evaluateExtremeAfterWind(
  player: Player,
  towers: Tower[],
  score: number,
  targetPoints: number,
  depth: number,
  extremeCache: Map<string, StrategicValue>,
  windCache: Map<string, StrategicValue>,
  futureCache: Map<string, StrategicValue>,
): StrategicValue {
  if (depth === 0) return evaluateNextTurn(player, towers, score, targetPoints, futureCache);
  const key = `${depth}:${strategicStateKey(towers, score)}`;
  const cached = extremeCache.get(key);
  if (cached) return cached;

  const futurePlayer: Player = {
    ...player,
    score,
    towers: canonicalTowerOrder(towers).map((tower, index) => ({ ...tower, slot: index })),
  };
  let winProbability = 0;
  let points = 0;
  for (let die = 1; die <= 6; die += 1) {
    const bank = chooseBestBank(futurePlayer, targetPoints, die);
    const build = chooseNormalBuildAction(futurePlayer, die);
    const buildValue = evaluateAfterFutureWind(
      player,
      towersAfterBuild(futurePlayer, build),
      score,
      targetPoints,
      depth - 1,
      extremeCache,
      windCache,
      futureCache,
    );

    let turnValue = buildValue;
    if (bank?.wins) {
      turnValue = { winProbability: 1, points: bank.points };
    } else if (bank) {
      const remaining = futurePlayer.towers.filter((tower) => !bank.towerIds.includes(tower.id));
      const bankContinuation = evaluateAfterFutureWind(
        player,
        remaining,
        score + bank.points,
        targetPoints,
        depth - 1,
        extremeCache,
        windCache,
        futureCache,
      );
      const bankValue = {
        winProbability: bankContinuation.winProbability,
        points: bank.points + bankContinuation.points,
      };
      if (isBetterStrategicValue(bankValue, buildValue)) turnValue = bankValue;
    }
    winProbability += turnValue.winProbability;
    points += turnValue.points;
  }
  const value = { winProbability: winProbability / 6, points: points / 6 };
  extremeCache.set(key, value);
  return value;
}

function evaluateAfterFutureWind(
  player: Player,
  towers: Tower[],
  score: number,
  targetPoints: number,
  remainingDepth: number,
  extremeCache: Map<string, StrategicValue>,
  windCache: Map<string, StrategicValue>,
  futureCache: Map<string, StrategicValue>,
): StrategicValue {
  const key = `${remainingDepth}:${strategicStateKey(towers, score)}`;
  const cached = windCache.get(key);
  if (cached) return cached;

  const shield = towerShield(towers.length);
  let winProbability = 0;
  let points = 0;
  for (let wind = 2; wind <= 12; wind += 1) {
    const frequency = WIND_SUM_COUNTS[wind - 2]!;
    const survivors = towers
      .filter((tower) => wind < heightLimit(tower.height) + shield)
      .map((tower) => ({ ...tower }));
    const future = remainingDepth === 0
      ? evaluateNextTurn(player, survivors, score, targetPoints, futureCache)
      : evaluateExtremeAfterWind(
        player,
        survivors,
        score,
        targetPoints,
        remainingDepth,
        extremeCache,
        windCache,
        futureCache,
      );
    winProbability += frequency * future.winProbability;
    points += frequency * future.points;
  }
  const value = { winProbability: winProbability / 36, points: points / 36 };
  windCache.set(key, value);
  return value;
}

function isBetterStrategicValue(candidate: StrategicValue, current: StrategicValue): boolean {
  return candidate.winProbability > current.winProbability + 1e-9 ||
    (Math.abs(candidate.winProbability - current.winProbability) <= 1e-9 &&
      candidate.points > current.points + 1e-9);
}

function strategicStateKey(towers: readonly Tower[], score: number): string {
  return `${score}:${towers.map((tower) => tower.height).sort((a, b) => a - b).join(',')}`;
}

function canonicalTowerOrder(towers: readonly Tower[]): Tower[] {
  return towers
    .map((tower) => ({ ...tower }))
    .sort((left, right) =>
      left.height - right.height ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function evaluateNextTurn(
  player: Player,
  towers: Tower[],
  score: number,
  targetPoints: number,
  cache: Map<string, StrategicValue>,
): StrategicValue {
  const key = `${score}:${towers.map((tower) => tower.height).sort((a, b) => a - b).join(',')}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const futurePlayer: Player = {
    ...player,
    score,
    towers: canonicalTowerOrder(towers).map((tower, index) => ({ ...tower, slot: index })),
  };
  let winProbability = 0;
  let points = 0;
  for (let die = 1; die <= 6; die += 1) {
    const bank = chooseBestBank(futurePlayer, targetPoints, die);
    const build = chooseNormalBuildAction(futurePlayer, die);
    const buildValue = expectedSkylineValue(towersAfterBuild(futurePlayer, build));
    if (bank?.wins) {
      winProbability += 1;
      points += bank.points;
    } else {
      points += bank && bank.value > buildValue ? bank.value : buildValue;
    }
  }
  const value = { winProbability: winProbability / 6, points: points / 6 };
  cache.set(key, value);
  return value;
}

function enumerateBuildActions(player: Player, turnDie: number): PlayerAction[] {
  const newSlot = player.towers.length < MAX_TOWERS ? firstFreeSlot(player.towers) : null;
  const targetCount = player.towers.length + (newSlot === null ? 0 : 1);
  const allocations = Array<number>(targetCount).fill(0);
  const actions: PlayerAction[] = [];

  const visit = (index: number, remaining: number): void => {
    if (index === targetCount) {
      const placements = new Map<string, number>();
      const newTowerSlots = new Map<string, number>();
      for (let towerIndex = 0; towerIndex < player.towers.length; towerIndex += 1) {
        const floors = allocations[towerIndex]!;
        if (floors > 0) placements.set(player.towers[towerIndex]!.id, floors);
      }
      if (newSlot !== null) {
        const floors = allocations[player.towers.length]!;
        if (floors > 0) {
          const id = uniqueBotTowerId(player.towers, newSlot);
          placements.set(id, floors);
          newTowerSlots.set(id, newSlot);
        }
      }
      actions.push(placementsToAction(placements, newTowerSlots));
      return;
    }
    for (let amount = 0; amount <= remaining; amount += 1) {
      allocations[index] = amount;
      visit(index + 1, remaining - amount);
    }
  };
  visit(0, turnDie);
  return actions;
}

function enumerateBankActions(player: Player, turnDie: number): PlayerAction[] {
  const maxTowers = Math.min(turnDie, player.towers.length);
  const actions: PlayerAction[] = [];
  const selectedIds: string[] = [];
  const visit = (nextIndex: number): void => {
    if (selectedIds.length > 0) actions.push({ kind: 'bank', towerIds: [...selectedIds] });
    if (selectedIds.length === maxTowers) return;
    for (let index = nextIndex; index < player.towers.length; index += 1) {
      selectedIds.push(player.towers[index]!.id);
      visit(index + 1);
      selectedIds.pop();
    }
  };
  visit(0);
  return actions;
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
