import { chooseBotActionWithDetails } from './bot.js';
import type { BotDecisionRequest, BotDecisionResponse } from './bot.js';

self.addEventListener('message', (event: MessageEvent<BotDecisionRequest>) => {
  let response: BotDecisionResponse;
  try {
    const request = event.data;
    response = {
      ...chooseBotActionWithDetails(
        request.player,
        request.targetPoints,
        request.turnDie,
        request.opponents,
        request.searchPartition,
      ),
    };
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : 'Robot decision failed.',
    };
  }
  self.postMessage(response);
});
