import {
  beginRematch,
  beginGame,
  beginBuildingTurn,
  beginNextRound,
  createMatch,
  createPlayerView,
  heightLimit,
  isLegalAction,
  MAX_WIN_POINTS,
  MAX_TOWER_SHIELD,
  MAX_TOWERS,
  MAX_PLAYERS,
  MIN_WIN_POINTS,
  MIN_PLAYERS,
  resolveRound,
  returnToLobby,
  towerShield,
  towerPoints,
  validateTargetPoints,
  type MatchState,
  type Player,
  type PlayerAction,
  type Tower,
} from './game';
import { chooseBotBuildAction, chooseBotTurnChoice } from './bot';
import { parseMessage, type PeerMessage } from './protocol';
import { Peer, PeerError, PeerErrorType, type DataConnection } from 'peerjs';
import { createRoomCode, formatRoomCode, normalizeRoomCode } from './room-code';
import './style.css';

interface HostConnection {
  channel: DataConnection;
  playerId: string | null;
}

type Screen = 'home' | 'host' | 'guest-setup' | 'guest';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('The game page is missing its app container.');

let screen: Screen = 'home';
let hostState: MatchState | null = null;
let guestState: MatchState | null = null;
let hostId = '';
let guestId = '';
let playerName = '';
let guestName = '';
let submitted = new Map<string, PlayerAction>();
let submittedCount = 0;
let guestSubmitted = false;
let selectedAllocations = new Map<string, number>();
let selectedBankTowerId: string | null = null;
let selectedTurnMode: 'build' | 'bank' | null = null;
let guestBuildRequested = false;
let hostConnections = new Set<HostConnection>();
let hostPeer: Peer | null = null;
let hostRoomCode = '';
let creatingRoomCode = false;
let roomGeneration = 0;
let guestPeer: Peer | null = null;
let guestChannel: DataConnection | null = null;
let notice = '';
let failure = '';
let autoRollTimer: number | null = null;
let botResolveTimer: number | null = null;

const NEXT_TURN_DELAY_MS = 3_000;
const ROUND_WIND_DISPLAY_MS = 5_000;
const BOT_TURN_DELAY_MS = 2_500;

const PEER_OPTIONS = {
  host: '0.peerjs.com',
  port: 443,
  secure: true,
  debug: 0,
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function waitForPeerOpen(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('The room service did not respond. Check your internet connection and try again.')));
    }, 15_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      peer.off('open', onOpen);
      peer.off('error', onError);
      peer.off('close', onClose);
      callback();
    };
    const onOpen = () => finish(resolve);
    const onError = (error: PeerError<`${PeerErrorType}`>) => finish(() => reject(error));
    const onClose = () => finish(() => reject(new Error('The room service connection closed.')));
    peer.on('open', onOpen);
    peer.on('error', onError);
    peer.on('close', onClose);
  });
}

function peerFailureMessage(error: unknown, role: 'host' | 'guest'): string {
  const type = error instanceof Error && 'type' in error && typeof error.type === 'string' ? error.type : '';
  if (type === 'peer-unavailable') {
    return 'No open room uses that code. Check with the host and try again.';
  }
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'Could not reach the room service. Check your internet connection and try again.';
  }
  if (type === 'browser-incompatible') {
    return 'This browser does not support the connection needed to join the game.';
  }
  const detail = error instanceof Error ? ` ${error.message}` : '';
  return role === 'host'
    ? `Could not create a room.${detail}`
    : `Could not join the room.${detail}`;
}

function rollDice(): [number, number] {
  const values = new Uint32Array(2);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(values);
    return [(values[0]! % 6) + 1, (values[1]! % 6) + 1];
  }
  return [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
}

function rollTurnDie(): number {
  const value = new Uint32Array(1);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(value);
    return (value[0]! % 6) + 1;
  }
  return Math.floor(Math.random() * 6) + 1;
}

function currentState(): MatchState | null {
  return screen === 'host' ? hostState : guestState;
}

function connectedPlayers(state: MatchState): Player[] {
  return state.players.filter((player) => player.connected);
}

function showNotice(message: string): void {
  notice = message;
  failure = '';
  selectedAllocations.clear();
  selectedBankTowerId = null;
  selectedTurnMode = null;
  guestBuildRequested = false;
  selectedTurnMode = null;
  guestBuildRequested = false;
  render();
}

function showFailure(message: string): void {
  failure = message;
  notice = '';
  render();
}

function noticeMarkup(): string {
  if (failure) return `<p class="notice notice-error" role="alert">${escapeHtml(failure)}</p>`;
  if (notice) return `<p class="notice" role="status">${escapeHtml(notice)}</p>`;
  return '';
}

function headerMarkup(): string {
  return `<header class="masthead">
    <a class="brand" href="#" data-action="home" aria-label="Skyline Dice home">
      <span class="brand-mark" aria-hidden="true">▥</span>
      <span>SKYLINE <span class="brand-light">DICE</span></span>
    </a>
    <span class="masthead-tag">A game of wind &amp; nerve</span>
  </header>`;
}

function footerMarkup(): string {
  return `<footer class="site-footer">
    <span>Your roll. Your skyline.</span>
    <button class="text-button" data-action="rules" type="button">How to play</button>
  </footer>`;
}

function render(): void {
  if (!app) return;
  const body = screen === 'home' ? renderHome() :
    screen === 'guest-setup' ? renderGuestSetup() :
      screen === 'host' ? renderHost() : renderGuest();
  app.innerHTML = `${headerMarkup()}${noticeMarkup()}${body}${footerMarkup()}`;
}

function renderHome(): string {
  return `<section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">BUILD HIGH. BANK WISE.</p>
      <h1>How far will<br />you <em>rise?</em></h1>
      <p class="lead">Grow your skyline one floor at a time. Bank a tower before the wind brings it down.</p>
      <div class="hero-actions">
        <button class="button button-primary" data-action="show-host-form" type="button">Host a game <span aria-hidden="true">↗</span></button>
        <button class="button button-secondary" data-action="show-guest" type="button">Join a game</button>
      </div>
      <p class="quiet-note">2–5 players · 15–20 min · no app to install</p>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="sun"></div><div class="wind wind-one"></div><div class="wind wind-two"></div>
      <div class="skyline">
        <i style="--height:4;--delay:0"></i><i style="--height:7;--delay:1"></i>
        <i style="--height:5;--delay:2"></i><i style="--height:9;--delay:3"></i>
        <i style="--height:6;--delay:4"></i><i style="--height:8;--delay:5"></i>
        <i style="--height:4;--delay:6"></i>
      </div>
      <div class="art-caption"><span class="dot"></span> WIND INCOMING</div>
    </div>
  </section>
  <section class="feature-strip" aria-label="Game highlights">
    <article><span class="feature-icon">↗</span><div><strong>Take your turn</strong><p>Roll a die and split floors across your skyline.</p></div></article>
    <article><span class="feature-icon">◉</span><div><strong>Find shelter</strong><p>Every extra tower adds wind protection.</p></div></article>
    <article><span class="feature-icon">▤</span><div><strong>Bank your points</strong><p>Secure a tower before it tumbles.</p></div></article>
  </section>
  <section class="connect-note">
    <span class="connect-icon" aria-hidden="true">⌁</span>
    <div><strong>Playing on phones?</strong><p>Open this page on every device. The host shares one short room code; guests enter it to join. Keep the host tab open and in the foreground.</p></div>
  </section>
  <div id="host-form-slot"></div>
`;
}

function renderGuestSetup(): string {
  return `<section class="narrow-panel">
    <button class="back-link" data-action="home" type="button">← Back</button>
    <p class="eyebrow">JOIN THE SKYLINE</p>
    <h1>Enter the host's<br /><em>room code.</em></h1>
    <form id="guest-form" class="form-card">
      <label for="guest-name">Your name</label>
      <input id="guest-name" name="name" maxlength="18" autocomplete="nickname" required value="${escapeHtml(guestName)}" placeholder="e.g. Robin" />
      <label for="guest-room-code">Room code</label>
      <input id="guest-room-code" class="room-code-input" name="roomCode" maxlength="11" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. 7K2M-Q9RX" />
      <button class="button button-primary button-full" type="submit">Join room</button>
    </form>
    <p class="quiet-note">The host must keep their room open. Codes are case-insensitive.</p>
  </section>`;
}

function renderHost(): string {
  if (!hostState) return '';
  const state = hostState;
  if (state.status !== 'lobby') return renderGame(state, true);
  return `<section class="game-panel">
    <div class="section-heading"><div><p class="eyebrow">HOST LOBBY</p><h1>Your skyline <em>starts here.</em></h1></div><span class="pill">${state.players.length}/${MAX_PLAYERS} players</span></div>
    <p class="lead-small">You are the host and a player. Share this short room code; guests enter it on their devices.</p>
    <div class="pair-card room-code-card">
      <p class="eyebrow">ROOM CODE</p>
      ${hostRoomCode
        ? `<input id="host-room-code" class="room-code-input" readonly value="${formatRoomCode(hostRoomCode)}" aria-label="Room code" />
          <button class="button button-secondary button-full copy-code-button" data-action="copy-room-code" type="button">Copy room code</button>`
        : `<p class="quiet-note">${creatingRoomCode ? 'Getting a room code…' : 'Could not connect to the room service.'}</p>
          ${creatingRoomCode ? '' : '<button class="button button-secondary" data-action="retry-room-code" type="button">Try again</button>'}`}
      <p class="quiet-note">Share it only with players in your game. The host page must stay open.</p>
    </div>
    <div class="target-setting-card">
      <label for="target-points">Points needed to win</label>
      <div class="target-input-row"><input id="target-points" type="number" min="${MIN_WIN_POINTS}" max="${MAX_WIN_POINTS}" step="1" value="${state.targetPoints}" /><span>points</span></div>
      <p class="quiet-note">The first player to reach this score wins after the round resolves.</p>
    </div>
    <div class="player-list">${state.players.map((player) => playerMarkup(player, true)).join('')}</div>
    <div class="lobby-robot-control">
      <button class="button button-secondary" data-action="add-robot" type="button" ${state.players.length >= MAX_PLAYERS ? 'disabled' : ''}>＋ Add a robot</button>
      <p class="quiet-note">Robots choose automatically. Add one to play solo or mix robots with guests.</p>
    </div>
    <div class="pair-area">
      ${connectedPlayers(state).length >= MIN_PLAYERS
        ? `<button class="button button-primary button-full start-button" data-action="start-game" type="button" ${creatingRoomCode || !hostRoomCode ? 'disabled' : ''}>Start game <span aria-hidden="true">→</span></button>`
        : `<p class="quiet-note">Waiting for at least one guest. The host counts as a player.</p>`}
    </div>
    <details class="help-details"><summary>Connection notes</summary><p>Joining uses the PeerJS Cloud signaling service to find the room; gameplay uses a direct encrypted browser connection when the network allows it. Internet access is required for signaling. The room code is an invite—share it privately. iPhone may suspend a background tab, so keep the host page open in front.</p></details>
  </section>`;
}

function renderGuest(): string {
  if (!guestState) {
    return `<section class="narrow-panel">
      <p class="eyebrow">GUEST CONNECTION</p><h1>Joining the<br /><em>skyline.</em></h1>
      <p class="lead-small">Connecting to the host. Keep this page open; the lobby will appear when the connection is ready.</p>
      <button class="button button-secondary" data-action="cancel-guest" type="button">Leave</button>
    </section>`;
  }
  if (guestState.status === 'lobby') {
    return `<section class="game-panel">
      <div class="section-heading"><div><p class="eyebrow">CONNECTED TO HOST</p><h1>Waiting for<br /><em>liftoff.</em></h1></div><span class="pill">${guestState.players.length}/${MAX_PLAYERS} players</span></div>
      <p class="lead-small">Win target: <strong>${guestState.targetPoints} points</strong></p>
      <div class="player-list">${guestState.players.map((player) => playerMarkup(player, false)).join('')}</div>
      <p class="lead-small">The host will start the game when everyone is ready. Keep this page open.</p>
      <button class="button button-secondary" data-action="cancel-guest" type="button">Leave game</button>
    </section>`;
  }
  return renderGame(guestState, false);
}

function playerMarkup(player: Player, hostControls: boolean): string {
  const me = player.id === (screen === 'host' ? hostId : guestId);
  const hostPlayerId = hostState?.players[0]?.id ?? guestState?.players[0]?.id;
  return `<article class="player-row ${player.connected ? '' : 'player-offline'}">
    <span class="player-avatar" aria-hidden="true">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>
    <span class="player-name">${escapeHtml(player.name)}${me ? ' <span class="you-tag">YOU</span>' : ''}${player.id === hostPlayerId ? ' <span class="host-tag">HOST</span>' : ''}<span class="room-win-tag">${player.roomWins} room win${player.roomWins === 1 ? '' : 's'}</span></span>
    <span class="player-meta">${player.isBot ? 'Robot' : player.connected ? 'Connected' : 'Disconnected'}</span>
    ${hostControls && player.isBot ? `<button class="text-button danger-text" data-action="remove-robot" data-player="${escapeHtml(player.id)}" type="button">Remove</button>` : ''}
    ${hostControls && player.id !== hostId && !player.connected ? `<button class="text-button danger-text" data-action="remove-player" data-player="${escapeHtml(player.id)}" type="button">Remove</button>` : ''}
  </article>`;
}

function renderGame(state: MatchState, isHost: boolean): string {
  const playerId = isHost ? hostId : guestId;
  const me = state.players.find((player) => player.id === playerId);
  const activePlayer = state.players[state.currentPlayerIndex];
  const isMyTurn = activePlayer?.id === playerId;
  const isSubmitted = isHost ? submitted.has(hostId) : guestSubmitted;
  const canChoose = state.status === 'choice' && isMyTurn && !isSubmitted && !!me;
  const latestRound = state.history.at(-1);
  const choices = state.status === 'choice' && canChoose && state.turnMode === 'choose'
    ? selectedTurnMode === 'bank'
      ? `<div class="action-card turn-choice-card"><p class="eyebrow">BANKING</p><h2>Choose a tower to bank</h2><button class="text-button" data-action="switch-to-build" type="button">Choose building instead</button></div>`
      : `<div class="action-card turn-choice-card">
          <p class="eyebrow">CHOOSE YOUR TURN</p><h2>Build or bank?</h2>
          ${guestBuildRequested ? '<p class="quiet-note">Rolling the die…</p>' : `<div class="turn-choice-buttons"><button class="button button-primary" data-action="choose-build" type="button">Build <small>Roll a die</small></button><button class="button button-secondary" data-action="choose-bank" type="button" ${me?.towers.length ? '' : 'disabled'}>Bank <small>Choose a tower</small></button></div>`}
        </div>`
    : state.status === 'choice' && !canChoose
      ? `<div class="wait-card"><span class="spinner" aria-hidden="true"></span><div><strong>${escapeHtml(activePlayer?.name ?? 'A player')} is taking their turn</strong><p>${isSubmitted ? 'Their choice is locked in.' : state.turnMode === 'build' ? 'They are placing floors from their die roll.' : 'They are choosing to build or bank.'}</p></div></div>`
      : '';
  const toppleAnimation = state.dice !== null && latestRound?.toppled.length
    ? `<div class="topple-animation" role="status" aria-live="polite"><span class="falling-tower" aria-hidden="true">▥</span><strong>The wind toppled ${latestRound.toppled.length} tower${latestRound.toppled.length === 1 ? '' : 's'}!</strong><span>${latestRound.toppled.map((item) => escapeHtml(state.players.find((player) => player.id === item.playerId)?.name ?? 'A player')).join(', ')}</span></div>`
    : '';

  return `<section class="game-panel board-panel">
    <div class="section-heading"><div><p class="eyebrow">${state.status === 'finished' ? 'GAME OVER' : `ROUND ${state.round} · PLAYER ${state.currentPlayerIndex + 1}/${state.players.length}`}</p><h1>${state.status === 'finished' ? 'The skyline is <em>set.</em>' : `${escapeHtml(activePlayer?.name ?? 'Next player')}'s <em>turn.</em>`}</h1></div>
      ${state.dice ? `<div class="wind-card"><span>ROUND ${latestRound?.round ?? state.round} WIND</span><div class="dice-pair">${dieMarkup(state.dice[0])}${dieMarkup(state.dice[1])}</div><strong>${state.dice[0] + state.dice[1]}</strong><small>shared wind</small></div>` : ''}
    </div>
    ${state.status === 'choice' ? `<p class="lead-small">Reach ${state.targetPoints} points to win. Choose banking or building first. Building rolls one die; banking does not.</p>` : ''}
    ${state.status === 'choice' && state.turnMode === 'build' && state.turnDie !== null ? `<div class="turn-roll-card" aria-live="polite"><span class="eyebrow">${escapeHtml(activePlayer?.name ?? 'Player')} rolled</span><div class="turn-die">${dieMarkup(state.turnDie)}</div><strong>${state.turnDie} floor${state.turnDie === 1 ? '' : 's'} available</strong></div>` : ''}
    ${toppleAnimation}
    ${me ? towerBoardMarkup(me, state, canChoose, selectedTurnMode) : ''}
    <section class="scoreboard" aria-label="Players and scores">
      ${state.players.map((player, index) => `<article class="score-card ${player.id === playerId ? 'score-card-me' : ''} ${state.status === 'choice' && index === state.currentPlayerIndex ? 'score-card-active' : ''}">
        <div class="score-card-top"><span class="player-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><span class="score-name">${escapeHtml(player.name)}${player.id === playerId ? ' <span class="you-tag">YOU</span>' : ''}${player.isBot ? ' <span class="robot-tag">ROBOT</span>' : ''}${!player.connected ? ' <span class="host-tag">OFFLINE</span>' : ''}</span></div>
        <div class="score-number">${player.score}<small> pts</small></div>
        <div class="room-win-count">${player.roomWins} room win${player.roomWins === 1 ? '' : 's'}</div>
        ${state.status === 'choice' && index === state.currentPlayerIndex ? '<div class="active-turn-tag">TAKING TURN</div>' : ''}
        ${isHost && player.id !== hostId && !player.connected ? `<button class="text-button danger-text" data-action="remove-player" data-player="${escapeHtml(player.id)}" type="button">Remove disconnected player</button>` : ''}
      </article>`).join('')}
    </section>
    ${choices}
    ${state.status === 'resolution' ? `<section class="resolution-card"><p class="eyebrow">${state.dice ? `ROUND ${state.round} COMPLETE` : `PLAYER ${state.currentPlayerIndex + 1} COMPLETE`}</p><h2>${state.dice ? 'The shared wind has passed.' : 'The wind waits.'}</h2>${state.dice && latestRound ? fallSummaryMarkup(latestRound, state, playerId) : ''}
      <p class="quiet-note">${state.dice ? 'The next round starts automatically in 5 seconds.' : 'Every player takes one turn before the shared wind is rolled. The next turn starts in 3 seconds.'}</p></section>` : ''}
    ${state.status === 'finished' ? `<section class="resolution-card winner-card"><p class="eyebrow">FINAL STANDINGS · TARGET ${state.targetPoints}</p><h2>${state.winnerIds.length > 1 ? 'A shared victory.' : `${escapeHtml(state.players.find((player) => player.id === state.winnerIds[0])?.name ?? 'A player')} wins!`}</h2><p>${state.winnerIds.length > 1 ? 'The tied winners each earn one room win.' : 'The winner earns one room win.'}</p>${isHost
      ? `<div class="rematch-actions"><button class="button button-primary button-full" data-action="rematch" type="button" ${state.players.length < MIN_PLAYERS || state.players.some((player) => !player.connected) ? 'disabled' : ''}>Play again in this room</button><button class="button button-secondary button-full" data-action="return-lobby" type="button">Return to room lobby</button></div>`
      : '<p class="quiet-note">The host can start another game in this room or return to the lobby.</p>'}</section>` : ''}
    <section class="history-card"><div class="history-heading"><p class="eyebrow">THE BUILD LOG</p><span>${state.history.length} round${state.history.length === 1 ? '' : 's'}</span></div>
      ${state.history.length ? `<ol class="history-list">${[...state.history].reverse().map((round) => historyMarkup(round, state, playerId)).join('')}</ol>` : '<p class="quiet-note">Each round’s wind and tower falls will appear here.</p>'}
    </section>
    ${state.status !== 'finished' ? `<details class="help-details"><summary>Rules &amp; wind limits</summary>${rulesMarkup()}</details>` : ''}
  </section>`;
}

function dieMarkup(value: number): string {
  const positions: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  return `<span class="die" aria-label="Die shows ${value}">${Array.from({ length: 9 }, (_, index) => `<i class="${positions[value]?.includes(index) ? 'die-dot' : ''}"></i>`).join('')}</span>`;
}

function windScaleMarkup(limit: number, wind: number | null): string {
  const windSummary = limit > 12
    ? 'All shown wind strengths are safe.'
    : `Wind strengths ${Math.max(limit, 2)} through 12 can topple this tower.`;
  const currentSummary = wind === null
    ? ''
    : wind >= limit
      ? ` Current wind ${wind} topples it.`
      : ` Current wind ${wind} is safe.`;
  const markers = Array.from({ length: 11 }, (_, index) => {
    const value = index + 2;
    const danger = value >= limit;
    const current = wind === value;
    return `<i class="wind-mark ${danger ? 'wind-mark-danger' : 'wind-mark-safe'} ${current ? 'wind-mark-current' : ''}" aria-hidden="true"></i>`;
  }).join('');
  return `<span class="wind-scale" role="img" aria-label="Wind totals 2 through 12. Green means safe; coral means a topple. ${windSummary}${currentSummary}">${markers}</span>`;
}

function towerBoardMarkup(
  player: Player,
  state: MatchState,
  canChoose: boolean,
  selectedMode: 'build' | 'bank' | null,
): string {
  const wind = state.dice ? state.dice[0] + state.dice[1] : null;
  const turnDie = state.turnDie ?? 0;
  const building = canChoose && state.turnMode === 'build';
  const banking = canChoose && state.turnMode === 'choose' && selectedMode === 'bank';
  const spent = Array.from(selectedAllocations.values()).reduce((sum, value) => sum + value, 0);
  const pendingTowerCount = Array.from(selectedAllocations.keys()).filter((key) => key.startsWith('new-')).length;
  const hasFloorBudget = building && spent < turnDie;
  const canAddNewTower = hasFloorBudget &&
    pendingTowerCount === 0 &&
    player.towers.length < MAX_TOWERS;
  const floorsMarkup = (height: number) =>
    Array.from({ length: height }, (_, floor) => `<i class="tower-floor" style="--floor:${floor}"></i>`).join('');
  const undoButton = (key: string, amount: number) => building && amount > 0
    ? `<button class="tower-undo" data-action="undo-floor" data-slot="${escapeHtml(key)}" type="button" aria-label="Undo one floor from this tower">− Undo one</button>`
    : '';

  const existingTowerSlot = (tower: Tower) => {
    const additionalHeight = selectedAllocations.get(tower.id) ?? 0;
    const height = tower.height + (building ? additionalHeight : 0);
    const limit = heightLimit(height) + towerShield(player.towers.length + pendingTowerCount);
    const atRisk = wind !== null && wind >= limit;
    const selected = banking && selectedBankTowerId === tower.id;
    const disabled = !building && !banking || (building && !hasFloorBudget);
    const prompt = building
      ? additionalHeight ? `+${additionalHeight} this turn · click to add more` : 'Click to add a floor'
      : banking ? `Bank for +${towerPoints(tower.height)} points` : '';
    return `<div class="tower-slot-card">
      <button class="tower-slot ${selected ? 'tower-slot-selected' : ''} ${additionalHeight ? 'tower-slot-pending' : ''}" data-action="tower-slot" data-slot="${escapeHtml(tower.id)}" type="button" aria-label="Tower, height ${height}. ${prompt}" ${disabled ? 'disabled' : ''}>
        <span class="tower-body">
          <span class="tower-visual ${atRisk ? 'tower-visual-risk' : ''}" aria-hidden="true">${floorsMarkup(height)}</span>
          ${windScaleMarkup(limit, wind)}
        </span>
        ${prompt ? `<span class="tower-slot-prompt">${prompt}</span>` : ''}
      </button>${undoButton(tower.id, additionalHeight)}
    </div>`;
  };
  const emptyTowerSlot = (index: number) => {
    const key = `new-${index}`;
    const height = selectedAllocations.get(key);
    const pending = height !== undefined;
    const disabled = pending ? !hasFloorBudget : !canAddNewTower;
    const limit = pending
      ? heightLimit(height) + towerShield(player.towers.length + pendingTowerCount)
      : 0;
    const atRisk = pending && wind !== null && wind >= limit;
    const slotPrompt = pending
      ? `New tower · height ${height} · click to add more`
      : pendingTowerCount > 0
        ? 'Only one new tower per turn'
        : 'Click to build a new tower here';
    return `<div class="tower-slot-card">
      <button class="tower-slot ${pending ? 'tower-slot-pending' : 'tower-slot-placeholder'}" data-action="tower-slot" data-slot="${key}" type="button" aria-label="${slotPrompt}" ${disabled ? 'disabled' : ''}>
        <span class="tower-body">
          <span class="tower-visual ${pending && atRisk ? 'tower-visual-risk' : ''} ${pending ? '' : 'tower-visual-empty'}" aria-hidden="true">${pending ? floorsMarkup(height) : '<span>＋</span>'}</span>
          ${pending ? windScaleMarkup(limit, wind) : ''}
        </span>
        <span class="tower-slot-prompt">${pending ? 'Click to add more floors' : 'Dotted slot · build here'}</span>
      </button>${undoButton(key, height ?? 0)}
    </div>`;
  };
  const towersBySlot = new Map(player.towers.map((tower, index) => [tower.slot ?? index, tower]));
  const towerSlots = Array.from({ length: MAX_TOWERS }, (_, slot) => {
    const tower = towersBySlot.get(slot);
    return tower ? existingTowerSlot(tower) : emptyTowerSlot(slot);
  }).join('');
  const selectedBank = player.towers.find((tower) => tower.id === selectedBankTowerId);
  const canCommit = building
    ? spent > 0 && spent <= turnDie && player.towers.length + pendingTowerCount <= MAX_TOWERS
    : banking && selectedBank !== undefined;
  const hasControls = building || banking;
  const commitLabel = banking && selectedBank
    ? `Bank tower for +${towerPoints(selectedBank.height)} points`
    : 'Place floors and face the wind';
  return `<section class="tower-board-panel" aria-label="Your towers">
    <div class="tower-board-heading"><div><p class="eyebrow">YOUR SKYLINE</p><h2>Your towers</h2></div><span>${player.towers.length + pendingTowerCount}/${MAX_TOWERS} towers · ${player.bankedTowers} banked</span></div>
    <div class="tower-board">${towerSlots}</div>
    <div class="wind-scale-legend" aria-label="Wind scale legend"><span><i class="wind-mark wind-mark-safe"></i>Safe</span><span><i class="wind-mark wind-mark-danger"></i>Topples</span><span class="wind-scale-range">2 ↑ 12</span></div>
    ${banking && player.towers.length === 0 ? '<p class="quiet-note">You have no towers to bank. Choose building instead.</p>' : ''}
    ${hasControls ? `<div class="commit-move-panel"><p>${building ? `Floors added: <strong>${spent}/${turnDie}</strong>` : selectedBank ? `Selected: <strong>height ${selectedBank.height}</strong>` : 'Select a tower to bank.'}</p><button class="button button-primary button-full" data-action="commit-move" type="button" ${canCommit ? '' : 'disabled'}>${commitLabel}</button><p class="quiet-note">${building ? `Click a tower to add floors; use Undo one to take a floor back. Start at most one new tower per turn, up to ${MAX_TOWERS} standing towers.` : 'Banking scores the selected tower and does not roll a die.'}</p></div>` : ''}
  </section>`;
}

function fallSummaryMarkup(round: MatchState['history'][number], state: MatchState, viewerId: string): string {
  return `<ul class="fall-summary">${state.players.map((player) => {
    const count = round.fallenCounts[player.id] ?? 0;
    const label = player.id === viewerId ? 'Your towers' : escapeHtml(player.name);
    return `<li><span>${label}</span><strong>${count} tower${count === 1 ? '' : 's'} fell</strong></li>`;
  }).join('')}</ul>`;
}

function historyMarkup(round: MatchState['history'][number], state: MatchState, viewerId: string): string {
  const name = (id: string) => state.players.find((player) => player.id === id)?.name ?? 'A player';
  const ownAction = round.actions.find((action) => action.playerId === viewerId);
  const ownBanked = round.banked.find((banked) => banked.playerId === viewerId);
  const ownToppled = round.toppled.filter((tower) => tower.playerId === viewerId);
  const personalSummary = [
    ownAction ? `You ${ownAction.description.toLowerCase()}` : '',
    ownBanked ? `You banked +${ownBanked.points}` : '',
    ownToppled.length ? `Your tower${ownToppled.length === 1 ? '' : 's'} fell` : '',
  ].filter(Boolean).join(' · ') || 'Your towers held.';
  const otherFallSummary = state.players
    .filter((player) => player.id !== viewerId)
    .map((player) => `${name(player.id)}: ${round.fallenCounts[player.id] ?? 0} fell`)
    .join(' · ');
  const turnRolls = round.turnRolls.map((turn) => {
    const turnPlayer = state.players.find((player) => player.id === turn.playerId)?.name ?? 'A player';
    return `${escapeHtml(turnPlayer)} ${turn.choice === 'build' ? `build d${turn.die}` : 'bank (no die)'}`;
  }).join(' · ');
  return `<li><div class="history-round"><b>R${round.round}</b><span class="history-dice">wind ${round.dice[0]} + ${round.dice[1]} = ${round.wind}</span></div>
    <p class="history-dice">Turn rolls: ${turnRolls}</p>
    <p>${escapeHtml(personalSummary)}</p>${otherFallSummary ? `<p class="history-bad">${escapeHtml(otherFallSummary)}</p>` : ''}</li>`;
}

function rulesMarkup(): string {
  return `<p>The host sets a room win target from ${MIN_WIN_POINTS} to ${MAX_WIN_POINTS} points. Players take turns in order and first choose to build or bank. Building rolls one six-sided die; click existing towers to add floors or a dotted slot to start one new tower in that position, spending up to that many floors across towers. Use the Undo one button to take a floor back. You can have up to ${MAX_TOWERS} standing towers. Banking scores one tower's triangular value (1 + 2 + … + height) and does not roll a die. After all players have taken a turn, two wind dice are rolled and every unbanked tower is tested. Extra standing towers shield your whole skyline: each tower beyond the first adds +1 to every tower's wind limit, up to +${MAX_TOWER_SHIELD} protection. Tied high scores share the win.</p>
    <div class="limit-table"><span>Height</span><span>Base wind limit</span>${[1, 2, 3, 4, 5, 6, 7].map((height) => `<b>${height === 7 ? '7+' : height}</b><b>${heightLimit(height)}+</b>`).join('')}</div>
    <p class="quiet-note">Build rolls and the current turn are shared with everyone. The next turn starts automatically after 3 seconds.</p>`;
}

async function copyCode(selector: string, successMessage: string): Promise<void> {
  const field = app?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field) throw new Error('The connection code is not available to copy.');
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(field.value);
    } else {
      field.focus();
      field.select();
      if (!document.execCommand('copy')) throw new Error('Automatic copy is not available.');
    }
    showNotice(successMessage);
  } catch (error) {
    showFailure(
      error instanceof Error
        ? `Could not copy automatically: ${error.message}. The code is selected so you can copy it manually.`
        : 'Could not copy automatically. The code is selected so you can copy it manually.',
    );
    const refreshedField = app?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    refreshedField?.focus();
    refreshedField?.select();
  }
}

function messageForConnection(connection: HostConnection, message: PeerMessage): void {
  if (message.type === 'join') {
    if (hostState?.status !== 'lobby') {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'This room has already started.' }));
      return;
    }
    if (message.name.trim().length < 1 || message.name.length > 18 || message.playerId.length > 64) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'Please choose a name with 1–18 characters.' }));
      return;
    }
    if (hostState.players.some((player) => player.id === message.playerId)) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'That player is already in the room.' }));
      return;
    }
    if (connectedPlayers(hostState).length >= MAX_PLAYERS) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'This room is full.' }));
      return;
    }
    connection.playerId = message.playerId;
    hostState.players.push({
      id: message.playerId,
      name: message.name.trim(),
      score: 0,
      bankedTowers: 0,
      roomWins: 0,
      towers: [],
      connected: true,
    });
    notice = `${message.name.trim()} joined the room.`;
    failure = '';
    broadcastState();
    render();
    return;
  }
  if (message.type === 'build') {
    if (
      !hostState ||
      hostState.status !== 'choice' ||
      hostState.turnMode !== 'choose' ||
      connection.playerId !== message.playerId ||
      hostState.players[hostState.currentPlayerIndex]?.id !== message.playerId ||
      submitted.has(message.playerId)
    ) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'A build roll cannot be started now.' }));
      return;
    }
    hostState = beginBuildingTurn(hostState, rollTurnDie());
    broadcastState();
    render();
    return;
  }
  if (message.type === 'action') {
    if (
      !hostState ||
      hostState.status !== 'choice' ||
      connection.playerId !== message.playerId ||
      submitted.has(message.playerId) ||
      hostState.players[hostState.currentPlayerIndex]?.id !== message.playerId
    ) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'It is not your turn or your move was already submitted.' }));
      return;
    }
    const player = hostState.players.find((item) => item.id === message.playerId);
    if (!player || !isLegalAction(player, message.action, hostState.turnMode, hostState.turnDie)) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'That action is not legal for the current turn.' }));
      return;
    }
    submitted.set(message.playerId, message.action);
    broadcastState();
    maybeResolveRound();
    return;
  }
}

function attachHostConnection(connection: HostConnection): void {
  connection.channel.on('data', (data: unknown) => {
    try {
      if (typeof data !== 'string') throw new Error('Received an invalid game message.');
      messageForConnection(connection, parseMessage(data));
    } catch (error) {
      if (connection.channel.open) {
        connection.channel.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Invalid game message.',
        }));
      }
    }
  });
  connection.channel.on('open', () => {
    notice = 'Connection ready. The guest can join the lobby now.';
    render();
  });
  connection.channel.on('close', () => {
    hostConnections.delete(connection);
    const playerId = connection.playerId;
    if (!playerId || !hostState) return;
    const player = hostState.players.find((item) => item.id === playerId);
    if (player) player.connected = false;
    notice = `${player?.name ?? 'A guest'} disconnected. Remove them to continue.`;
    broadcastState();
    render();
  });
  connection.channel.on('error', (error) => {
    showFailure(peerFailureMessage(error, 'host'));
  });
}

function broadcastState(): void {
  if (!hostState) return;
  submittedCount = submitted.size;
  for (const connection of hostConnections) {
    if (connection.playerId && connection.channel.open) {
      connection.channel.send(JSON.stringify({
        type: 'state',
        state: createPlayerView(hostState, connection.playerId),
        submittedCount,
        playerId: connection.playerId,
      }));
    }
  }
}

function submitBotActions(): void {
  if (!hostState || hostState.status !== 'choice') return;
  const player = hostState.players[hostState.currentPlayerIndex];
  if (!player?.isBot || hostState.turnMode !== 'choose' || submitted.has(player.id)) return;
  const choice = chooseBotTurnChoice(player, hostState.targetPoints);
  if (choice.kind === 'bank') {
    submitted.set(player.id, choice);
  } else {
    hostState = beginBuildingTurn(hostState, rollTurnDie());
    submitted.set(player.id, chooseBotBuildAction(player, hostState.turnDie!));
  }
}

function maybeResolveRound(): void {
  const activePlayer = hostState?.players[hostState.currentPlayerIndex];
  if (!hostState || hostState.status !== 'choice' || !activePlayer || !submitted.has(activePlayer.id)) {
    broadcastState();
    render();
    return;
  }
  if (activePlayer.isBot) {
    broadcastState();
    render();
    if (botResolveTimer === null) {
      botResolveTimer = window.setTimeout(() => {
        botResolveTimer = null;
        resolveSubmittedTurn();
      }, BOT_TURN_DELAY_MS);
    }
    return;
  }
  resolveSubmittedTurn();
}

function resolveSubmittedTurn(): void {
  const activePlayer = hostState?.players[hostState.currentPlayerIndex];
  if (!hostState || hostState.status !== 'choice' || !activePlayer || !submitted.has(activePlayer.id)) {
    return;
  }
  try {
    const alreadyTurned = new Set(hostState.roundTurnRolls.map((turn) => turn.playerId));
    const windDice = hostState.players.every((player) => player.id === activePlayer.id || alreadyTurned.has(player.id))
      ? rollDice()
      : null;
    hostState = resolveRound(hostState, submitted.get(activePlayer.id)!, windDice);
    submitted.clear();
    submittedCount = 0;
    selectedAllocations.clear();
    selectedBankTowerId = null;
    selectedTurnMode = null;
    broadcastState();
    render();
    if (hostState.status === 'resolution') scheduleAutomaticNextRound();
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'Could not resolve this round.');
  }
}

function scheduleAutomaticNextRound(): void {
  if (autoRollTimer !== null) window.clearTimeout(autoRollTimer);
  const delay = hostState?.dice === null ? NEXT_TURN_DELAY_MS : ROUND_WIND_DISPLAY_MS;
  autoRollTimer = window.setTimeout(() => {
    autoRollTimer = null;
    if (screen !== 'host' || !hostState || hostState.status !== 'resolution') return;
    hostState = beginNextRound(hostState);
    submitted.clear();
    submittedCount = 0;
    selectedAllocations.clear();
    selectedBankTowerId = null;
    selectedTurnMode = null;
    guestBuildRequested = false;
    submitBotActions();
    maybeResolveRound();
  }, delay);
}

function chooseBuild(playerId: string): void {
  const state = currentState();
  if (
    !state ||
    state.status !== 'choice' ||
    state.turnMode !== 'choose' ||
    state.players[state.currentPlayerIndex]?.id !== playerId
  ) {
    showFailure('It is not time to choose building for this turn.');
    return;
  }
  selectedTurnMode = 'build';
  selectedBankTowerId = null;
  if (screen === 'host') {
    hostState = beginBuildingTurn(state, rollTurnDie());
    broadcastState();
    render();
    return;
  }
  if (!guestChannel?.open) {
    showFailure('The host connection is unavailable. Reconnect before rolling.');
    return;
  }
  guestBuildRequested = true;
  guestChannel.send(JSON.stringify({ type: 'build', playerId }));
  render();
}

function commitAction(playerId: string, action: PlayerAction): void {
  const state = currentState();
  if (
    !state ||
    state.status !== 'choice' ||
    state.players[state.currentPlayerIndex]?.id !== playerId ||
    (screen === 'host' && submitted.has(playerId)) ||
    guestSubmitted
  ) return;
  const player = state.players.find((item) => item.id === playerId);
  if (!player || !isLegalAction(player, action, state.turnMode, state.turnDie)) {
    showFailure('That action is no longer available. Choose an eligible tower and try again.');
    return;
  }
  submitted.set(playerId, action);
  selectedAllocations.clear();
  selectedBankTowerId = null;
  selectedTurnMode = null;
  if (screen === 'host') {
    submittedCount = submitted.size;
    maybeResolveRound();
  } else {
    if (!guestChannel?.open) {
      submitted.delete(playerId);
      showFailure('The host connection is unavailable. Reconnect before submitting your turn.');
      return;
    }
    selectedAllocations.clear();
    selectedBankTowerId = null;
    guestChannel?.send(JSON.stringify({ type: 'action', playerId, action }));
    guestSubmitted = true;
    showNotice('Your turn is in. The wind waits for everyone to finish.');
    broadcastGuestStatus();
  }
}

function broadcastGuestStatus(): void {
  if (screen !== 'guest') return;
  render();
}

async function createHostPeer(): Promise<void> {
  if (!hostState || creatingRoomCode) return;
  creatingRoomCode = true;
  hostPeer?.destroy();
  hostPeer = null;
  hostRoomCode = '';
  const generation = roomGeneration;
  render();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createRoomCode();
      const peer = new Peer(code, PEER_OPTIONS);
      hostPeer = peer;
      try {
        await waitForPeerOpen(peer);
      } catch (error) {
        peer.destroy();
        if (hostPeer === peer) hostPeer = null;
        if (generation !== roomGeneration) return;
        if (error instanceof PeerError && error.type === PeerErrorType.UnavailableID) continue;
        throw error;
      }
      if (generation !== roomGeneration) {
        peer.destroy();
        if (hostPeer === peer) hostPeer = null;
        return;
      }
      hostRoomCode = code;
      peer.on('connection', (channel) => {
        if (
          hostPeer !== peer ||
          !hostState ||
          hostState.status !== 'lobby' ||
          connectedPlayers(hostState).length >= MAX_PLAYERS
        ) {
          channel.close();
          return;
        }
        const connection: HostConnection = { channel, playerId: null };
        hostConnections.add(connection);
        attachHostConnection(connection);
      });
      peer.on('error', (error) => {
        if (hostPeer === peer) showFailure(peerFailureMessage(error, 'host'));
      });
      peer.on('disconnected', () => {
        if (hostPeer === peer) {
          showFailure('The room service connection was lost. Existing players may stay connected, but new guests cannot join.');
        }
      });
      notice = 'Room ready. Share the code with your guests.';
      failure = '';
      return;
    }
    throw new Error('Could not reserve a unique room code. Try again.');
  } catch (error) {
    if (generation === roomGeneration) {
      hostPeer?.destroy();
      hostPeer = null;
      hostRoomCode = '';
      showFailure(peerFailureMessage(error, 'host'));
    }
  } finally {
    if (generation === roomGeneration) {
      creatingRoomCode = false;
      render();
    }
  }
}

function connectGuest(roomCode: string): void {
  const peer = new Peer(PEER_OPTIONS);
  guestPeer = peer;
  guestState = null;
  guestSubmitted = false;
  selectedAllocations.clear();
  selectedBankTowerId = null;
  selectedTurnMode = null;
  guestBuildRequested = false;
  guestId = randomId();
  screen = 'guest';
  notice = 'Connecting to the room…';
  failure = '';
  render();
  void waitForPeerOpen(peer).then(() => {
    if (guestPeer !== peer) return;
    peer.on('error', (error) => {
      if (guestPeer === peer) showFailure(peerFailureMessage(error, 'guest'));
    });
    peer.on('disconnected', () => {
      if (guestPeer === peer) showFailure('The room service connection was lost. Leave and try joining again.');
    });
    const channel = peer.connect(roomCode, { serialization: 'binary' });
    guestChannel = channel;
    const timeout = window.setTimeout(() => {
      if (guestPeer === peer && !channel.open) {
        channel.close();
        showFailure('The host did not accept the connection. Check the room code and make sure the host page is open.');
      }
    }, 20_000);
    channel.on('open', () => {
      window.clearTimeout(timeout);
      channel.send(JSON.stringify({ type: 'join', playerId: guestId, name: guestName }));
      notice = 'Connected to the host. Joining the lobby…';
      render();
    });
    channel.on('data', (data: unknown) => {
      try {
        if (typeof data !== 'string') throw new Error('Received an invalid game message.');
        const message = parseMessage(data);
        if (message.type === 'state' && message.playerId === guestId) {
          const previousRound = guestState?.round;
          const previousTurnMode = guestState?.turnMode;
          const previousPlayerIndex = guestState?.currentPlayerIndex;
          guestState = message.state;
          submittedCount = message.submittedCount;
          if (
            guestState.status !== 'choice' ||
            guestState.round !== previousRound ||
            guestState.turnMode !== previousTurnMode ||
            guestState.currentPlayerIndex !== previousPlayerIndex
          ) {
            guestSubmitted = false;
            selectedAllocations.clear();
            selectedBankTowerId = null;
            selectedTurnMode = null;
            guestBuildRequested = false;
          }
          failure = '';
          notice = '';
          screen = 'guest';
          render();
        } else if (message.type === 'error') {
          guestBuildRequested = false;
          showFailure(message.message);
        }
      } catch (error) {
        showFailure(error instanceof Error ? error.message : 'Could not read the host update.');
      }
    });
    channel.on('close', () => {
      window.clearTimeout(timeout);
      if (guestPeer !== peer) return;
      showFailure(guestState
        ? 'The host connection closed. The match cannot be recovered if the host page was closed.'
        : 'The connection closed before joining. Check the room code and try again.');
    });
    channel.on('error', (error) => {
      window.clearTimeout(timeout);
      if (guestPeer === peer) showFailure(peerFailureMessage(error, 'guest'));
    });
  }).catch((error: unknown) => {
    if (guestPeer !== peer) return;
    peer.destroy();
    guestPeer = null;
    guestChannel = null;
    showFailure(peerFailureMessage(error, 'guest'));
  });
}

function removePlayer(playerId: string): void {
  if (!hostState || playerId === hostId) return;
  const player = hostState.players.find((item) => item.id === playerId);
  if (!player) return;
  const removedIndex = hostState.players.findIndex((item) => item.id === playerId);
  const wasActive = hostState.status === 'choice' && removedIndex === hostState.currentPlayerIndex;
  hostState.players = hostState.players.filter((item) => item.id !== playerId);
  if (removedIndex < hostState.currentPlayerIndex) hostState.currentPlayerIndex -= 1;
  if (hostState.currentPlayerIndex >= hostState.players.length) hostState.currentPlayerIndex = 0;
  submitted.delete(playerId);
  if (wasActive && hostState.status === 'choice' && hostState.players.length > 0) {
    hostState.turnDie = null;
    hostState.turnMode = 'choose';
  }
  if (wasActive) {
    selectedAllocations.clear();
    selectedBankTowerId = null;
    selectedTurnMode = null;
    guestBuildRequested = false;
  }
  for (const connection of hostConnections) {
    if (connection.playerId === playerId) {
      hostConnections.delete(connection);
      connection.channel.close();
    }
  }
  notice = `${player.name} was removed from the room.`;
  broadcastState();
  if (hostState.status === 'choice') {
    submitBotActions();
    maybeResolveRound();
  }
  else render();
}

function addRobot(): void {
  if (!hostState || hostState.status !== 'lobby' || hostState.players.length >= MAX_PLAYERS) return;
  const robotNames = new Set(hostState.players.filter((player) => player.isBot).map((player) => player.name));
  let number = 1;
  while (robotNames.has(`Robot ${number}`)) number += 1;
  hostState.players.push({
    id: `robot-${randomId()}`,
    name: `Robot ${number}`,
    score: 0,
    bankedTowers: 0,
    roomWins: 0,
    towers: [],
    connected: true,
    isBot: true,
  });
  notice = 'Robot added to the lobby.';
  broadcastState();
  render();
}

function removeRobot(playerId: string): void {
  if (!hostState || hostState.status !== 'lobby') return;
  const player = hostState.players.find((item) => item.id === playerId && item.isBot);
  if (!player) return;
  hostState.players = hostState.players.filter((item) => item.id !== playerId);
  notice = `${player.name} removed from the lobby.`;
  broadcastState();
  render();
}

function resetRoom(): void {
  if (autoRollTimer !== null) window.clearTimeout(autoRollTimer);
  if (botResolveTimer !== null) window.clearTimeout(botResolveTimer);
  autoRollTimer = null;
  botResolveTimer = null;
  roomGeneration += 1;
  creatingRoomCode = false;
  hostState = null;
  guestState = null;
  for (const connection of hostConnections) connection.channel.close();
  hostConnections.clear();
  hostPeer?.destroy();
  hostPeer = null;
  hostRoomCode = '';
  guestPeer?.destroy();
  guestPeer = null;
  guestChannel = null;
  submitted.clear();
  submittedCount = 0;
  guestSubmitted = false;
  selectedAllocations.clear();
  selectedBankTowerId = null;
  screen = 'home';
  notice = '';
  failure = '';
  render();
}

app.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== 'target-points') return;
  if (!hostState || hostState.status !== 'lobby') return;
  try {
    const points = Number(target.value);
    validateTargetPoints(points);
    hostState.targetPoints = points;
    broadcastState();
    showNotice(`Win target set to ${points} points.`);
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'Could not update the win target.');
  }
});

app.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'home') {
      if (screen === 'host' || screen === 'guest') {
        const leave = window.confirm('Leave this room? The active match will end for this device.');
        if (!leave) return;
        resetRoom();
        return;
      }
      screen = 'home';
      render();
    } else if (action === 'show-host-form') {
      const slot = app.querySelector<HTMLElement>('#host-form-slot');
      if (slot) {
        slot.innerHTML = `<form id="host-form" class="host-form"><label for="host-name">Your name</label><input id="host-name" name="name" maxlength="18" autocomplete="nickname" required placeholder="e.g. Alex" /><button class="button button-primary" type="submit">Create room</button></form>`;
        slot.querySelector<HTMLInputElement>('#host-name')?.focus();
      }
    } else if (action === 'show-guest') {
      screen = 'guest-setup';
      render();
    } else if (action === 'copy-room-code') {
      await copyCode('#host-room-code', 'Room code copied.');
    } else if (action === 'retry-room-code') {
      await createHostPeer();
    } else if (action === 'add-robot') {
      addRobot();
    } else if (action === 'remove-robot' && button.dataset.player) {
      removeRobot(button.dataset.player);
    } else if (action === 'choose-build' || action === 'switch-to-build') {
      chooseBuild(screen === 'host' ? hostId : guestId);
    } else if (action === 'choose-bank') {
      selectedTurnMode = 'bank';
      selectedBankTowerId = null;
      selectedAllocations.clear();
      render();
    } else if (action === 'undo-floor' && button.dataset.slot) {
      if (currentState()?.turnMode !== 'build') return;
      const key = button.dataset.slot;
      const selectedAmount = selectedAllocations.get(key) ?? 0;
      if (selectedAmount === 0) return;
      if (selectedAmount === 1) selectedAllocations.delete(key);
      else selectedAllocations.set(key, selectedAmount - 1);
      render();
    } else if (action === 'tower-slot' && button.dataset.slot) {
      const key = button.dataset.slot;
      if (selectedTurnMode === 'bank') {
        selectedBankTowerId = key;
      } else if (currentState()?.turnMode === 'build') {
        const state = currentState();
        const playerId = screen === 'host' ? hostId : guestId;
        const player = state?.players.find((item) => item.id === playerId);
        const turnDie = state?.turnDie ?? 0;
        const spent = Array.from(selectedAllocations.values()).reduce((sum, value) => sum + value, 0);
        const selectedAmount = selectedAllocations.get(key) ?? 0;
        if (!player || spent >= turnDie) return;
        if (key.startsWith('new-') && selectedAmount === 0) {
          const pendingCount = Array.from(selectedAllocations.keys()).filter((item) => item.startsWith('new-')).length;
          if (pendingCount > 0 || player.towers.length >= MAX_TOWERS) return;
        }
        selectedAllocations.set(key, selectedAmount + 1);
      } else {
        return;
      }
      render();
    } else if (action === 'commit-move') {
      const playerId = screen === 'host' ? hostId : guestId;
      const state = currentState();
      if (state?.turnMode === 'build') {
        const placements = Array.from(selectedAllocations, ([towerId, elements]) => ({
          towerId: towerId.startsWith('new-') ? null : towerId,
          elements,
          ...(towerId.startsWith('new-') ? { slot: Number(towerId.slice(4)) } : {}),
        }));
        commitAction(playerId, { kind: 'build', placements });
      } else if (selectedTurnMode === 'bank' && selectedBankTowerId) {
        commitAction(playerId, { kind: 'bank', towerId: selectedBankTowerId });
      } else {
        throw new Error('Choose a valid action for your turn first.');
      }
    } else if (action === 'start-game' && hostState) {
      if (connectedPlayers(hostState).length < MIN_PLAYERS) {
        showFailure('At least two connected players are needed.');
        return;
      }
      if (connectedPlayers(hostState).length !== hostState.players.length) {
        showFailure('Remove disconnected players before starting the game.');
        return;
      }
      hostState = beginGame(hostState);
      submitted.clear();
      submittedCount = 0;
      selectedAllocations.clear();
      selectedBankTowerId = null;
      selectedTurnMode = null;
      submitBotActions();
      maybeResolveRound();
    } else if (action === 'rematch' && hostState) {
      hostState = beginRematch(hostState);
      submitted.clear();
      submittedCount = 0;
      selectedAllocations.clear();
      selectedBankTowerId = null;
      selectedTurnMode = null;
      submitBotActions();
      maybeResolveRound();
    } else if (action === 'return-lobby' && hostState) {
      if (autoRollTimer !== null) window.clearTimeout(autoRollTimer);
      autoRollTimer = null;
      hostState = returnToLobby(hostState);
      submitted.clear();
      submittedCount = 0;
      selectedAllocations.clear();
      selectedBankTowerId = null;
      selectedTurnMode = null;
      broadcastState();
      render();
    } else if (action === 'remove-player' && button.dataset.player) {
      removePlayer(button.dataset.player);
    } else if (action === 'cancel-guest') {
      const peer = guestPeer;
      guestPeer = null;
      guestChannel = null;
      guestState = null;
      guestSubmitted = false;
      selectedAllocations.clear();
      selectedBankTowerId = null;
      selectedTurnMode = null;
      guestBuildRequested = false;
      screen = 'home';
      notice = '';
      peer?.destroy();
      render();
    } else if (action === 'rules') {
      window.alert(`Players take turns. First choose to build or bank. Building rolls one die; click towers to add floors or a dotted slot to start one new tower in that position. Use the Undo one button to take a floor back; you can have up to seven standing towers. Banking scores one tower for 1 + 2 + … + height points and does not roll a die. After everyone has taken a turn, the shared two-die wind tests all standing towers. Every tower beyond your first adds +1 wind protection to all your towers, up to +3. First to the target wins.`);
    }
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'That action could not be completed.');
  }
});

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  try {
    if (form.id === 'host-form') {
      const data = new FormData(form);
      playerName = String(data.get('name') ?? '').trim();
      if (!playerName || playerName.length > 18) throw new Error('Enter a name with 1–18 characters.');
      hostId = randomId();
      hostState = createMatch({
        id: hostId,
        name: playerName,
        score: 0,
        bankedTowers: 0,
        roomWins: 0,
        towers: [],
        connected: true,
      });
      screen = 'host';
      notice = '';
      failure = '';
      render();
      await createHostPeer();
    } else if (form.id === 'guest-form') {
      const data = new FormData(form);
      guestName = String(data.get('name') ?? '').trim();
      if (!guestName || guestName.length > 18) throw new Error('Enter a name with 1–18 characters.');
      const roomCode = normalizeRoomCode(String(data.get('roomCode') ?? ''));
      connectGuest(roomCode);
    }
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'The form could not be submitted.');
  }
});

render();
