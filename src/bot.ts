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
  type Placement,
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

export type BotSearchValue = StrategicValue;

interface RankedAction {
  action: PlayerAction;
  value: StrategicValue;
}

export interface BotSearchPartition {
  index: number;
  count: number;
}

interface FutureTurnOptions {
  bank: BankCandidate | null;
  build: PlayerAction;
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
  searchPartition?: BotSearchPartition;
}

export interface BotActionResult {
  action: PlayerAction;
  extremeSearchDepthUsed?: number;
  searchCandidateIndex?: number;
  searchValue?: BotSearchValue;
}

export type BotDecisionResponse =
  | BotActionResult
  | { error: string };

const WIND_SUM_COUNTS = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
const OPPONENT_FORECAST_SIMULATIONS = 24;
const MAX_EXTREME_SEARCH_WORKERS = 4;
const WIND_SURVIVES = Array.from({ length: 12 }, (_, heightIndex) =>
  Array.from({ length: 4 }, (_, shield) =>
    Array.from({ length: 13 }, (_, wind) =>
      wind < heightLimit(heightIndex + 1) + shield)));
const WIND_TOPPLE_PROBABILITY = WIND_SURVIVES.map((heightOutcomes) =>
  heightOutcomes.map((windOutcomes) =>
    windOutcomes.reduce((total, survives, wind) =>
      total + (survives ? 0 : WIND_SUM_COUNTS[wind - 2] ?? 0), 0) / 36));

export function getExtremeSearchWorkerCount(
  hardwareConcurrency: number,
  turnDie: number,
  searchDepth: number,
): number {
  if (
    !Number.isInteger(hardwareConcurrency) ||
    hardwareConcurrency < 1 ||
    !Number.isInteger(turnDie) ||
    turnDie < 1 ||
    turnDie > 6 ||
    !isExtremeSearchDepth(searchDepth)
  ) return 1;
  if (searchDepth <= 10) return 1;
  const depthWorkerLimit = searchDepth >= 20 ? MAX_EXTREME_SEARCH_WORKERS : 2;
  return Math.min(depthWorkerLimit, hardwareConcurrency, turnDie + 1);
}

export function chooseBestBotActionResult(results: readonly BotActionResult[]): BotActionResult {
  if (results.length === 0) throw new Error('Robot search returned no candidate actions.');
  const evaluated = results.filter((result) =>
    result.searchCandidateIndex !== undefined && result.searchValue !== undefined);
  if (evaluated.length === 0) return results[0]!;

  let best = evaluated[0]!;
  for (const candidate of evaluated.slice(1)) {
    if (
      isBetterStrategicValue(candidate.searchValue!, best.searchValue!) ||
      (!isBetterStrategicValue(best.searchValue!, candidate.searchValue!) &&
        candidate.searchCandidateIndex! < best.searchCandidateIndex!)
    ) {
      best = candidate;
    }
  }
  return best;
}

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
    const action = chooseExtremeAction(player, targetPoints, turnDie, opponents).action;
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
  if (difficulty === 'extreme') {
    return chooseExtremeAction(player, targetPoints, turnDie, opponents, false).action;
  }
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

export function chooseBotActionWithDetails(
  player: Player,
  targetPoints: number,
  turnDie: number,
  opponents: readonly BotOpponent[] = [],
  searchPartition: BotSearchPartition = { index: 0, count: 1 },
): BotActionResult {
  if ((player.botDifficulty ?? 'normal') !== 'extreme') {
    return { action: chooseBotAction(player, targetPoints, turnDie, opponents) };
  }
  if (!Number.isInteger(targetPoints) || targetPoints < 1) {
    throw new Error('Robot target must be a positive whole number.');
  }
  validateBotDie(turnDie);
  if (
    !Number.isInteger(searchPartition.index) ||
    !Number.isInteger(searchPartition.count) ||
    searchPartition.count < 1 ||
    searchPartition.index < 0 ||
    searchPartition.index >= searchPartition.count
  ) {
    throw new Error('Extreme Robot search partition is invalid.');
  }
  const result = chooseExtremeAction(
    player,
    targetPoints,
    turnDie,
    opponents,
    true,
    searchPartition,
  );
  return {
    action: result.action,
    extremeSearchDepthUsed: result.searchDepth,
    ...(result.searchCandidateIndex === undefined
      ? {}
      : {
          searchCandidateIndex: result.searchCandidateIndex,
          searchValue: result.searchValue,
        }),
  };
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
  let bestAllocations: number[] | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  let bestFloors = -1;

  const evaluate = (remaining: number): void => {
    const floors = turnDie - remaining;
    if (floors === 0) return;
    const value = expectedSkylineValueAfterAllocation(player, allocations, newSlot);
    if (value > bestValue + 1e-9 || (Math.abs(value - bestValue) <= 1e-9 && floors > bestFloors)) {
      bestAllocations = [...allocations];
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
  if (!bestAllocations) throw new Error('Robot could not find a legal building target.');
  return buildActionFromAllocation(player, bestAllocations, newSlot);
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
      .filter((tower) => survivesWind(tower.height, shield, wind))
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
  searchPartition: BotSearchPartition = { index: 0, count: 1 },
): {
  action: PlayerAction;
  searchDepth: number;
  searchCandidateIndex?: number;
  searchValue?: StrategicValue;
} {
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
    return { action: bestBank ?? chooseHardBuildAction(player, turnDie), searchDepth: 0 };
  }

  const maxDepth = player.extremeSearchDepth ?? DEFAULT_EXTREME_SEARCH_DEPTH;
  if (!isExtremeSearchDepth(maxDepth)) {
    throw new Error('Extreme Robot search depth must be a whole number from 1 to 500.');
  }
  const winningBank = chooseBestBank(player, targetPoints, turnDie);
  if (includeBanking && winningBank?.wins) {
    return {
      action: { kind: 'bank', towerIds: winningBank.towerIds },
      searchDepth: 0,
    };
  }

  const actions = deduplicateExtremeActions(
    player,
    enumerateBuildActions(player, turnDie),
    includeBanking ? enumerateBankActions(player, turnDie) : [],
  );
  const rankingCache = new Map<string, StrategicValue>();
  const rankedActions = actions.map((action) => ({
    action,
    value: evaluateUltraAction(player, action, targetPoints, rankingCache),
  }));
  rankedActions.sort((left, right) =>
    searchPriority(right.value, targetPoints) - searchPriority(left.value, targetPoints));
  if (rankedActions.length === 0) throw new Error('Robot could not find a legal turn action.');
  const opponentWinRisk = forecastOpponentWinRisk(
    player,
    opponents,
    targetPoints,
    maxDepth + 1,
  );
  const searchActions = selectExtremeSearchActions(rankedActions, targetPoints);
  const partitionActions = searchActions.flatMap((action, index) =>
    index % searchPartition.count === searchPartition.index ? [{ action, index }] : []);
  const valuesByAction = new Map<PlayerAction, StrategicValue[]>(
    partitionActions.map(({ action }) => [action, []]),
  );
  // Share transpositions among root candidates in this worker's partition.
  const extremeCache = new Map<string, StrategicValue>();
  const windCache = new Map<string, StrategicValue>();
  const futureCache = new Map<string, StrategicValue>();
  const futureTurnCache = new Map<string, FutureTurnOptions>();

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    for (const { action } of partitionActions) {
      const value = evaluateExtremeAction(
        player,
        action,
        targetPoints,
        depth,
        extremeCache,
        windCache,
        futureCache,
        futureTurnCache,
      );
      valuesByAction.get(action)!.push(value);
    }
  }

  const finalActions = partitionActions.map(({ action, index }) => {
    const values = valuesByAction.get(action)!;
    const finalValue = values.at(-1);
    if (!finalValue) throw new Error('Robot search did not evaluate a candidate action.');
    return {
      action,
      index,
      value: {
        ...finalValue,
        winProbability: adjustForOpponentWins(values, opponentWinRisk),
      },
    };
  });
  if (finalActions.length === 0) {
    return { action: searchActions[0]!, searchDepth: maxDepth };
  }
  let best = finalActions[0]!;
  for (const candidate of finalActions.slice(1)) {
    if (isBetterStrategicValue(candidate.value, best.value)) best = candidate;
  }
  return {
    action: best.action,
    searchDepth: maxDepth,
    searchCandidateIndex: best.index,
    searchValue: best.value,
  };
}

function adjustForOpponentWins(values: readonly StrategicValue[], opponentWinRisk: readonly number[]): number {
  let previousChance = 0;
  let competitiveWinChance = 0;
  for (let index = 0; index < values.length; index += 1) {
    const chance = Math.max(previousChance, Math.min(1, values[index]!.winProbability));
    const newWinChance = chance - previousChance;
    const forecastRound = Math.min(index + 1, opponentWinRisk.length - 1);
    competitiveWinChance += newWinChance * (1 - opponentWinRisk[forecastRound]!);
    previousChance = chance;
  }
  return competitiveWinChance;
}

function deduplicateExtremeActions(
  player: Player,
  buildActions: readonly PlayerAction[],
  bankActions: readonly PlayerAction[],
): PlayerAction[] {
  const unique = new Map<string, PlayerAction>();
  for (const action of [...buildActions, ...bankActions]) {
    const key = action.kind === 'build'
      ? `build:${towersAfterBuild(player, action).map((tower) => tower.height).sort((a, b) => a - b).join(',')}`
      : `bank:${player.towers
        .filter((tower) => !action.towerIds.includes(tower.id))
        .map((tower) => tower.height)
        .sort((a, b) => a - b)
        .join(',')}:${player.towers
        .filter((tower) => action.towerIds.includes(tower.id))
        .reduce((total, tower) => total + towerPoints(tower.height), 0)}`;
    if (!unique.has(key)) unique.set(key, action);
  }
  return [...unique.values()];
}

function selectExtremeSearchActions(
  rankedActions: readonly RankedAction[],
  targetPoints: number,
): PlayerAction[] {
  const bestPriority = searchPriority(rankedActions[0]!.value, targetPoints);
  const nextPriority = rankedActions[1]
    ? searchPriority(rankedActions[1].value, targetPoints)
    : bestPriority;
  const margin = bestPriority - nextPriority;
  const limit = margin >= targetPoints * 0.2 ? 8 : margin >= targetPoints * 0.05 ? 16 : 32;
  const selected = rankedActions.slice(0, limit).map(({ action }) => action);
  const selectedKinds = new Set(selected.map((action) => action.kind));
  for (const kind of ['build', 'bank'] as const) {
    if (selectedKinds.has(kind)) continue;
    const alternative = rankedActions.find(({ action }) => action.kind === kind)?.action;
    if (alternative) selected.push(alternative);
  }
  return selected;
}

function searchPriority(value: StrategicValue, targetPoints: number): number {
  return value.winProbability * targetPoints + value.points;
}

function forecastOpponentWinRisk(
  player: Player,
  opponents: readonly BotOpponent[],
  targetPoints: number,
  maxFutureRounds: number,
): number[] {
  const risk = Array<number>(maxFutureRounds + 1).fill(0);
  if (opponents.length === 0) return risk;

  const survival = Array<number>(maxFutureRounds + 1).fill(1);
  for (const opponent of opponents) {
    const winsByRound = Array<number>(maxFutureRounds + 1).fill(0);
    for (let simulation = 0; simulation < OPPONENT_FORECAST_SIMULATIONS; simulation += 1) {
      const random = createForecastRandom(
        forecastSeed(player, opponent.player, targetPoints) + simulation,
      );
      let forecastPlayer = cloneForecastPlayer(opponent.player);
      let wonAt: number | null = null;

      const currentRound = forecastOpponentRound(
        forecastPlayer,
        targetPoints,
        opponent.turnDie,
        random,
      );
      forecastPlayer = currentRound.player;
      if (currentRound.won) wonAt = 0;

      for (let round = 1; wonAt === null && round <= maxFutureRounds; round += 1) {
        const next = forecastOpponentRound(
          forecastPlayer,
          targetPoints,
          rollForecastDie(random),
          random,
        );
        forecastPlayer = next.player;
        if (next.won) wonAt = round;
      }
      if (wonAt !== null) winsByRound[wonAt] += 1;
    }

    let cumulativeWinChance = 0;
    for (let round = 0; round <= maxFutureRounds; round += 1) {
      cumulativeWinChance += winsByRound[round]! / OPPONENT_FORECAST_SIMULATIONS;
      survival[round] *= 1 - cumulativeWinChance;
    }
  }
  for (let round = 0; round <= maxFutureRounds; round += 1) {
    risk[round] = 1 - survival[round]!;
  }
  return risk;
}

function forecastOpponentRound(
  player: Player,
  targetPoints: number,
  turnDie: number,
  random: () => number,
): { player: Player; won: boolean } {
  const bank = chooseBestBank(player, targetPoints, turnDie);
  const build = chooseNormalBuildAction(player, turnDie);
  const buildValue = expectedSkylineValue(towersAfterBuild(player, build));
  let score = player.score;
  let towers: Tower[];

  if (bank?.wins || (bank && bank.value > buildValue)) {
    const selected = new Set(bank.towerIds);
    score += bank.points;
    towers = player.towers.filter((tower) => !selected.has(tower.id)).map((tower) => ({ ...tower }));
  } else {
    towers = towersAfterBuild(player, build);
  }
  if (score >= targetPoints) return { player: { ...player, score, towers }, won: true };

  const wind = rollForecastDie(random) + rollForecastDie(random);
  const shield = towerShield(towers.length);
  return {
    player: {
      ...player,
      score,
      towers: towers.filter((tower) => survivesWind(tower.height, shield, wind)),
    },
    won: false,
  };
}

function cloneForecastPlayer(player: Player): Player {
  return {
    ...player,
    towers: player.towers.map((tower) => ({ ...tower })),
  };
}

function forecastSeed(player: Player, opponent: Player, targetPoints: number): number {
  const state = [
    player.id,
    player.score,
    player.towers.map((tower) => tower.height).join(','),
    opponent.id,
    opponent.score,
    opponent.towers.map((tower) => tower.height).join(','),
    targetPoints,
  ].join(':');
  let seed = 2166136261;
  for (let index = 0; index < state.length; index += 1) {
    seed = Math.imul(seed ^ state.charCodeAt(index), 16777619);
  }
  return seed >>> 0 || 1;
}

function createForecastRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function rollForecastDie(random: () => number): number {
  return 1 + Math.floor(random() * 6);
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
  futureTurnCache: Map<string, FutureTurnOptions>,
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
      .filter((tower) => survivesWind(tower.height, shield, wind))
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
      futureTurnCache,
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
  futureTurnCache: Map<string, FutureTurnOptions>,
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
    const { bank, build } = getFutureTurnOptions(futurePlayer, targetPoints, die, futureTurnCache);
    const buildValue = evaluateAfterFutureWind(
      player,
      towersAfterBuild(futurePlayer, build),
      score,
      targetPoints,
      depth - 1,
      extremeCache,
      windCache,
      futureCache,
      futureTurnCache,
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
        futureTurnCache,
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
  futureTurnCache: Map<string, FutureTurnOptions>,
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
      .filter((tower) => survivesWind(tower.height, shield, wind))
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
        futureTurnCache,
      );
    winProbability += frequency * future.winProbability;
    points += frequency * future.points;
  }
  const value = { winProbability: winProbability / 36, points: points / 36 };
  windCache.set(key, value);
  return value;
}

function getFutureTurnOptions(
  player: Player,
  targetPoints: number,
  turnDie: number,
  cache: Map<string, FutureTurnOptions>,
): FutureTurnOptions {
  const towersKey = player.towers
    .map((tower) => `${tower.id}:${tower.height}:${tower.slot ?? ''}`)
    .sort()
    .join(',');
  const key = `${player.score}:${targetPoints}:${turnDie}:${towersKey}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const options = {
    bank: chooseBestBank(player, targetPoints, turnDie),
    build: chooseHardBuildAction(player, turnDie),
  };
  cache.set(key, options);
  return options;
}

function isBetterStrategicValue(candidate: StrategicValue, current: StrategicValue): boolean {
  return candidate.winProbability > current.winProbability + 1e-9 ||
    (Math.abs(candidate.winProbability - current.winProbability) <= 1e-9 &&
      candidate.points > current.points + 1e-9);
}

function strategicStateKey(towers: readonly Tower[], score: number): string {
  const heights = towers.map((tower) => tower.height).sort((a, b) => a - b);
  return `${score.toString(36)}|${heights.map((height) => height.toString(36)).join('.')}`;
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
      actions.push(buildActionFromAllocation(player, allocations, newSlot));
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

function buildActionFromAllocation(
  player: Player,
  allocations: readonly number[],
  newSlot: number | null,
): PlayerAction {
  const placements: Placement[] = [];
  for (let index = 0; index < player.towers.length; index += 1) {
    const elements = allocations[index]!;
    if (elements > 0) placements.push({ towerId: player.towers[index]!.id, elements });
  }
  if (newSlot !== null) {
    const elements = allocations[player.towers.length]!;
    if (elements > 0) placements.push({ towerId: null, elements, slot: newSlot });
  }
  return { kind: 'build', placements };
}

function expectedSkylineValueAfterAllocation(
  player: Player,
  allocations: readonly number[],
  newSlot: number | null,
): number {
  const newTowerHeight = newSlot === null ? 0 : allocations[player.towers.length]!;
  const towerCount = player.towers.length + (newTowerHeight > 0 ? 1 : 0);
  const shield = towerShield(towerCount);
  let value = 0;
  for (let index = 0; index < player.towers.length; index += 1) {
    const height = player.towers[index]!.height + allocations[index]!;
    value += towerPoints(height) * (1 - toppleProbability(height, shield));
  }
  if (newTowerHeight > 0) {
    value += towerPoints(newTowerHeight) * (1 - toppleProbability(newTowerHeight, shield));
  }
  return value;
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
  const heightIndex = Math.max(0, Math.min(11, Math.floor(height) - 1));
  return WIND_TOPPLE_PROBABILITY[heightIndex]![shield]!;
}

function survivesWind(height: number, shield: number, wind: number): boolean {
  const heightIndex = Math.max(0, Math.min(11, Math.floor(height) - 1));
  return WIND_SURVIVES[heightIndex]![shield]![wind]!;
}
