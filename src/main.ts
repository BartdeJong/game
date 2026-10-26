import {
  beginRematch,
  beginGame,
  beginTurnRoll,
  beginNextRound,
  chooseTurnMode,
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
  isBotDifficulty,
  type BotDifficulty,
  type MatchState,
  type Player,
  type PlayerAction,
  type Tower,
} from './game';
import { chooseBotBuildAction, chooseBotTurnChoice } from './bot';
import { parseMessage, type PeerMessage } from './protocol';
import { Peer, PeerError, PeerErrorType, type DataConnection } from 'peerjs';
import { createRoomCode, formatRoomCode, normalizeRoomCode } from './room-code';
import { isLanguage, LANGUAGES, localizeApp, localizeText, type Language } from './i18n';
import './style.css';

interface HostConnection {
  channel: DataConnection;
  playerId: string | null;
}

interface HostRecoveryRecord {
  version: 1;
  roomCode: string;
  hostId: string;
  playerName: string;
  state: MatchState;
  submitted: Array<[string, PlayerAction]>;
  resumeTokens: Record<string, string>;
}

interface GuestRecoveryRecord {
  version: 1;
  roomCode: string;
  playerId: string;
  playerName: string;
  resumeToken: string;
}

type Screen = 'home' | 'host' | 'guest-setup' | 'guest';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('The game page is missing its app container.');
const screenReaderStatus = requireScreenReaderRegion('#screen-reader-status');
const screenReaderAlert = requireScreenReaderRegion('#screen-reader-alert');

function requireScreenReaderRegion(selector: string): HTMLElement {
  const region = document.querySelector<HTMLElement>(selector);
  if (!region) throw new Error(`The screen reader announcement region ${selector} is missing.`);
  return region;
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!manifestLink?.href) {
    console.error('The PWA manifest link is missing; offline app support is unavailable.');
    return;
  }
  const serviceWorkerUrl = new URL('sw.js', manifestLink.href);
  const scope = new URL('./', manifestLink.href).pathname;
  void navigator.serviceWorker.register(serviceWorkerUrl, { scope }).catch((error: unknown) => {
    console.error('Service worker registration failed; offline app support is unavailable.', error);
  });
}

const HOST_RECOVERY_KEY = 'skyline-dice.host-recovery.v1';
const GUEST_RECOVERY_KEY = 'skyline-dice.guest-recovery.v1';
const LANGUAGE_PREFERENCE_KEY = 'skyline-dice.language.v1';

let screen: Screen = 'home';
let language: Language = 'en';
let hostFormVisible = false;
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
let selectedBankTowerIds = new Set<string>();
let selectedTurnMode: 'build' | 'bank' | null = null;
let hostConnections = new Set<HostConnection>();
let hostPeer: Peer | null = null;
let hostRoomCode = '';
let hostResumeTokens = new Map<string, string>();
let creatingRoomCode = false;
let roomGeneration = 0;
let guestPeer: Peer | null = null;
let guestChannel: DataConnection | null = null;
let guestConnecting = false;
let guestRoomCode = '';
let guestResumeToken = '';
let hostRecoveryAvailable: HostRecoveryRecord | null = null;
let guestRecoveryAvailable: GuestRecoveryRecord | null = null;
let recoveryReadError = false;
let notice = '';
let failure = '';
let lastAnnouncedNotice = '';
let lastAnnouncedFailure = '';
let lastAnnouncedTurn = '';
let lastAnnouncedOutcome = '';
let notificationTimer: number | null = null;
let trackedNotification = '';
let autoRollTimer: number | null = null;
let animatedRollRound = 0;
const animatedRollPlayers = new Set<string>();
let playerRollReveal: { key: string; playerName: string; die: number } | null = null;
let playerRollRevealTimer: number | null = null;
const shownPlayerRolls = new Set<string>();
let lastRoundSkipPressAt: number | null = null;
let lastRoundSkipPressRound: number | null = null;
let botResolveTimer: number | null = null;

const ROUND_WIND_DISPLAY_MS = 8_000;
const ROUND_SKIP_DOUBLE_PRESS_MS = 1_000;
const BOT_TURN_DELAY_MS = 2_500;
const BOT_DIFFICULTY_OPTIONS: { value: BotDifficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];
const PLAYER_ROLL_REVEAL_MS = 2_800;
const NOTICE_DISPLAY_MS = 5_000;
const FAILURE_DISPLAY_MS = 10_000;

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHostRecovery(value: unknown): HostRecoveryRecord {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.roomCode !== 'string' ||
    typeof value.hostId !== 'string' ||
    typeof value.playerName !== 'string' ||
    !Array.isArray(value.submitted) ||
    !isObject(value.resumeTokens)
  ) {
    throw new Error('The saved host room has an invalid format.');
  }
  const roomCode = normalizeRoomCode(value.roomCode);
  if (roomCode !== value.roomCode) throw new Error('The saved room code is invalid.');
  const stateMessage = parseMessage(JSON.stringify({
    type: 'state',
    state: value.state,
    submittedCount: 0,
    playerId: value.hostId,
  }));
  if (stateMessage.type !== 'state') throw new Error('The saved host match is invalid.');
  const state = stateMessage.state;
  const hostPlayer = state.players.find((player) => player.id === value.hostId);
  if (!hostPlayer || hostPlayer.isBot || hostPlayer.name !== value.playerName) {
    throw new Error('The saved host is not part of this match.');
  }
  const playersById = new Map(state.players.map((player) => [player.id, player]));
  const submitted: Array<[string, PlayerAction]> = [];
  const submittedIds = new Set<string>();
  for (const entry of value.submitted) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new Error('The saved turn actions are invalid.');
    }
    const [playerId, actionValue] = entry;
    const actionMessage = parseMessage(JSON.stringify({ type: 'action', playerId, action: actionValue }));
    const player = playersById.get(playerId);
    const turn = state.roundTurnRolls.find((item) => item.playerId === playerId);
    if (
      actionMessage.type !== 'action' ||
      !player ||
      !turn ||
      submittedIds.has(playerId) ||
      state.status !== 'choice' ||
      turn.choice !== actionMessage.action.kind ||
      !isLegalAction(
        player,
        actionMessage.action,
        turn.choice === 'build' ? 'build' : 'choose',
        turn.die,
      )
    ) {
      throw new Error('The saved turn action cannot be resumed.');
    }
    submittedIds.add(playerId);
    submitted.push([playerId, actionMessage.action]);
  }
  const resumeTokens: Record<string, string> = {};
  for (const [playerId, token] of Object.entries(value.resumeTokens)) {
    const player = playersById.get(playerId);
    if (!player || player.isBot || playerId === value.hostId || typeof token !== 'string' || token.length < 1 || token.length > 128) {
      throw new Error('The saved guest credentials are invalid.');
    }
    resumeTokens[playerId] = token;
  }
  for (const player of state.players) {
    if (!player.isBot && player.id !== value.hostId && !resumeTokens[player.id]) {
      throw new Error('A guest is missing its saved resume credential.');
    }
  }
  return {
    version: 1,
    roomCode,
    hostId: value.hostId,
    playerName: value.playerName,
    state,
    submitted,
    resumeTokens,
  };
}

function parseGuestRecovery(value: unknown): GuestRecoveryRecord {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.roomCode !== 'string' ||
    typeof value.playerId !== 'string' ||
    typeof value.playerName !== 'string' ||
    typeof value.resumeToken !== 'string' ||
    value.resumeToken.length < 1 ||
    value.resumeToken.length > 128
  ) {
    throw new Error('The saved guest room has an invalid format.');
  }
  const roomCode = normalizeRoomCode(value.roomCode);
  if (roomCode !== value.roomCode) throw new Error('The saved room code is invalid.');
  return {
    version: 1,
    roomCode,
    playerId: value.playerId,
    playerName: value.playerName,
    resumeToken: value.resumeToken,
  };
}

function loadRecoveryRecord<T>(key: string, decode: (value: unknown) => T): T | null {
  let saved: string | null;
  try {
    saved = window.localStorage.getItem(key);
  } catch (error) {
    failure = `Could not read saved game data from this browser. ${error instanceof Error ? error.message : ''}`.trim();
    recoveryReadError = true;
    return null;
  }
  if (saved === null) return null;
  try {
    return decode(JSON.parse(saved) as unknown);
  } catch (error) {
    failure = `Saved game data could not be restored: ${error instanceof Error ? error.message : 'invalid data'}`;
    recoveryReadError = true;
    return null;
  }
}

function persistRecovery(): void {
  try {
    if (screen === 'host' && hostState && hostRoomCode) {
      const record: HostRecoveryRecord = {
        version: 1,
        roomCode: hostRoomCode,
        hostId,
        playerName,
        state: hostState,
        submitted: Array.from(submitted.entries()),
        resumeTokens: Object.fromEntries(hostResumeTokens),
      };
      window.localStorage.setItem(HOST_RECOVERY_KEY, JSON.stringify(record));
      hostRecoveryAvailable = record;
    }
    if (screen === 'guest' && guestId && guestRoomCode && guestResumeToken) {
      const record: GuestRecoveryRecord = {
        version: 1,
        roomCode: guestRoomCode,
        playerId: guestId,
        playerName: guestName,
        resumeToken: guestResumeToken,
      };
      window.localStorage.setItem(GUEST_RECOVERY_KEY, JSON.stringify(record));
      guestRecoveryAvailable = record;
    }
  } catch (error) {
    failure = `Could not save this game's recovery data. ${error instanceof Error ? error.message : ''}`.trim();
  }
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
  selectedBankTowerIds.clear();
  selectedTurnMode = null;
  render();
}

function showFailure(message: string): void {
  failure = message;
  notice = '';
  render();
}

function noticeMarkup(): string {
  if (failure) return `<div class="notice notice-error"><span>${escapeHtml(failure)}</span><button class="notice-dismiss" data-action="dismiss-notice" type="button" aria-label="Dismiss notification">×</button></div>`;
  if (notice) return `<div class="notice"><span>${escapeHtml(notice)}</span><button class="notice-dismiss" data-action="dismiss-notice" type="button" aria-label="Dismiss notification">×</button></div>`;
  return '';
}

function syncNotificationTimer(): void {
  const type = failure ? 'failure' : notice ? 'notice' : '';
  const message = failure || notice;
  const key = type ? `${type}:${message}` : '';
  if (key === trackedNotification) return;
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  notificationTimer = null;
  trackedNotification = key;
  if (!type) return;
  notificationTimer = window.setTimeout(() => {
    notificationTimer = null;
    if (trackedNotification !== key) return;
    if (type === 'failure' && failure === message) failure = '';
    if (type === 'notice' && notice === message) notice = '';
    trackedNotification = '';
    render();
  }, type === 'failure' ? FAILURE_DISPLAY_MS : NOTICE_DISPLAY_MS);
}

function dismissNotification(): void {
  notice = '';
  failure = '';
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  notificationTimer = null;
  trackedNotification = '';
  render();
}

function headerMarkup(): string {
  return `<header class="masthead">
    <a class="brand" href="#" data-action="home" aria-label="Skyline Dice home">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <circle cx="23.5" cy="7" r="4.5" />
        <path class="brand-wind" d="M17 8.5h12M19 11h9" />
        <path class="brand-tower" d="M3.5 28V20h4v8m1.5 0V15h4v13m1.5 0V19h4v9m1.5 0V12h4v16m1.5 0V18h4v10M2 28.5h28" />
        <path class="brand-windows" d="M4.5 22h2m-2 3h2m4.5-8h2m-2 3h2m-2 3h2m-2 3h2m3.5-6h2m-2 3h2m-2 3h2m3.5-14h2m-2 3h2m-2 3h2m-2 3h2m-2 3h2m3.5-8h2m-2 3h2m-2 3h2" />
      </svg>
      <span>SKYLINE <span class="brand-light">DICE</span></span>
    </a>
    <div class="masthead-tools">
      <span class="masthead-tag">A game of wind &amp; nerve</span>
      <label class="language-picker" for="language-select"><span>Language</span>
        <select id="language-select" aria-label="Language">${LANGUAGES.map((option) =>
    `<option value="${option.code}" ${option.code === language ? 'selected' : ''}>${option.label}</option>`,
  ).join('')}</select>
      </label>
    </div>
  </header>`;
}

function footerMarkup(): string {
  return `<footer class="site-footer">
    <span>Your roll. Your skyline.</span>
    <button class="text-button" data-action="rules" type="button">How to play</button>
  </footer>`;
}

function clearPlayerRollReveal(): void {
  if (playerRollRevealTimer !== null) window.clearTimeout(playerRollRevealTimer);
  playerRollRevealTimer = null;
  playerRollReveal = null;
  shownPlayerRolls.clear();
}

function revealPlayerRoll(round: number, playerId: string, playerName: string, die: number): void {
  const key = `${round}:${playerId}`;
  if (shownPlayerRolls.has(key)) return;
  shownPlayerRolls.add(key);
  if (playerRollRevealTimer !== null) window.clearTimeout(playerRollRevealTimer);
  playerRollReveal = { key, playerName, die };
  playerRollRevealTimer = window.setTimeout(() => {
    if (playerRollReveal?.key !== key) return;
    playerRollReveal = null;
    playerRollRevealTimer = null;
    render();
  }, PLAYER_ROLL_REVEAL_MS);
}

function render(): void {
  if (!app) return;
  persistRecovery();
  const body = screen === 'home' ? renderHome() :
    screen === 'guest-setup' ? renderGuestSetup() :
      screen === 'host' ? renderHost() : renderGuest();
  app.innerHTML = `${headerMarkup()}${noticeMarkup()}${body}${footerMarkup()}`;
  document.documentElement.lang = language;
  localizeApp(app, language);
  syncScreenReaderAnnouncements();
  syncNotificationTimer();
}

function syncScreenReaderAnnouncements(): void {
  const alertMessage = failure ? localizeText(failure, language) : '';
  if (alertMessage !== lastAnnouncedFailure) {
    screenReaderAlert.textContent = alertMessage;
    lastAnnouncedFailure = alertMessage;
  }

  const state = screen === 'host' ? hostState : screen === 'guest' ? guestState : null;
  if (state?.status === 'resolution' || state?.status === 'finished') {
    const latestRound = state.history.at(-1);
    const outcomeKey = `${state.status}:${state.round}:${state.dice?.join(',') ?? ''}:${latestRound?.toppled.length ?? ''}:${state.winnerIds.join(',')}`;
    lastAnnouncedTurn = '';
    if (outcomeKey !== lastAnnouncedOutcome) {
      lastAnnouncedOutcome = outcomeKey;
      if (alertMessage) return;
      if (state.status === 'resolution' && latestRound) {
        const toppleMessage = latestRound.toppled.length
          ? localizeText(`The wind toppled ${latestRound.toppled.length} tower${latestRound.toppled.length === 1 ? '' : 's'}!`, language)
          : localizeText('No towers toppled this round.', language);
        screenReaderStatus.textContent = [
          localizeText(`ROUND ${state.round} COMPLETE`, language),
          localizeText('The shared wind has passed.', language),
          toppleMessage,
        ].join(' ');
      } else if (state.status === 'finished') {
        const winners = state.players.filter((player) => state.winnerIds.includes(player.id));
        const winnerMessage = winners.length > 1
          ? localizeText('Shared victory!', language)
          : localizeText(`${winners[0]?.name ?? 'A player'} wins!`, language);
        screenReaderStatus.textContent = `${localizeText('GAME OVER', language)}. ${winnerMessage}`;
      }
      lastAnnouncedNotice = notice ? localizeText(notice, language) : '';
    }
    return;
  }
  lastAnnouncedOutcome = '';
  const playerId = screen === 'host' ? hostId : guestId;
  const ownTurn = state?.roundTurnRolls.find((turn) => turn.playerId === playerId);
  const isSubmitted = screen === 'host' ? submitted.has(playerId) : guestSubmitted;
  const turnKey = state?.status === 'choice'
    ? `${state.round}:${ownTurn?.choice ?? selectedTurnMode ?? 'choose'}:${ownTurn?.die ?? ''}:${isSubmitted}:${selectedBankTowerIds.size}`
    : '';

  if (turnKey && turnKey !== lastAnnouncedTurn) {
    lastAnnouncedTurn = turnKey;
    if (alertMessage) return;
    const message = isSubmitted
      ? localizeText('Your move is locked in.', language)
      : ownTurn?.choice === 'choose' && selectedTurnMode === 'build'
        ? `${localizeText('Build', language)}. ${localizeText(`${ownTurn.die} floors`, language)}.`
        : ownTurn?.choice === 'choose' && selectedTurnMode === 'bank'
            ? localizeText(`${selectedBankTowerIds.size} towers selected. Choose up to ${ownTurn.die} towers.`, language)
          : ownTurn?.choice === 'choose'
            ? `${localizeText(`You rolled ${ownTurn.die}`, language)}. ${localizeText('Build or bank?', language)}`
      : ownTurn?.choice === 'build'
        ? `${localizeText('Build', language)}. ${localizeText(`${ownTurn.die} floors`, language)}.`
        : ownTurn?.choice === 'bank'
          ? localizeText('Your move is locked in.', language)
          : localizeText('Waiting for your die roll…', language);
    screenReaderStatus.textContent = message;
    lastAnnouncedNotice = notice ? localizeText(notice, language) : '';
    return;
  }
  if (!turnKey) lastAnnouncedTurn = '';

  if (alertMessage) {
    screenReaderStatus.textContent = '';
    lastAnnouncedNotice = '';
    return;
  }
  const noticeMessage = notice ? localizeText(notice, language) : '';
  if (noticeMessage !== lastAnnouncedNotice) {
    screenReaderStatus.textContent = noticeMessage;
    lastAnnouncedNotice = noticeMessage;
  }
}

function renderHome(): string {
  return `<section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">BUILD HIGH. BANK WISE.</p>
      <h1>How high will you<br /><em>rise?</em></h1>
      <p class="lead">Grow your skyline one floor at a time. Bank a tower before the wind brings it down.</p>
      <div class="hero-actions">
        <button class="button button-primary" data-action="show-host-form" type="button">Host a game <span aria-hidden="true">↗</span></button>
        <button class="button button-secondary" data-action="show-guest" type="button">Join a game</button>
      </div>
      ${recoveryOptionsMarkup()}
      <p class="quiet-note">2–10 players · 15–20 min · no app to install</p>
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
    <article><span class="feature-icon">↗</span><div><strong>Take your turn</strong><p>Use your die roll to build across your skyline.</p></div></article>
    <article><span class="feature-icon">◉</span><div><strong>Find shelter</strong><p>Every extra tower adds wind protection.</p></div></article>
    <article><span class="feature-icon">▤</span><div><strong>Bank your points</strong><p>Secure a tower before it tumbles.</p></div></article>
  </section>
  <section class="connect-note">
    <span class="connect-icon" aria-hidden="true">⌁</span>
    <div><strong>Playing on phones?</strong><p>Open this page on every device. The host shares one short room code; guests enter it to join. Keep the host tab open and in the foreground.</p></div>
  </section>
  <div id="host-form-slot">${hostFormVisible ? hostFormMarkup() : ''}</div>
`;
}

function hostFormMarkup(): string {
  return `<form id="host-form" class="host-form"><label for="host-name">Your name</label><input id="host-name" name="name" maxlength="18" autocomplete="nickname" required placeholder="e.g. Alex" /><button class="button button-primary" type="submit">Create room</button></form>`;
}

function recoveryOptionsMarkup(): string {
  const options = [
    hostRecoveryAvailable
      ? `<div><strong>Saved host room · ${escapeHtml(formatRoomCode(hostRecoveryAvailable.roomCode))}</strong><button class="button button-secondary button-full" data-action="resume-host" type="button">Resume host room</button><button class="text-button" data-action="discard-host-recovery" type="button">Discard saved host room</button></div>`
      : '',
    guestRecoveryAvailable
      ? `<div><strong>Saved guest game · ${escapeHtml(formatRoomCode(guestRecoveryAvailable.roomCode))}</strong><button class="button button-secondary button-full" data-action="resume-guest" type="button">Rejoin as ${escapeHtml(guestRecoveryAvailable.playerName)}</button><button class="text-button" data-action="discard-guest-recovery" type="button">Discard saved guest game</button></div>`
      : '',
    recoveryReadError
      ? `<div><strong>Saved game recovery data is unavailable.</strong><button class="text-button" data-action="discard-recovery" type="button">Clear saved recovery data</button></div>`
      : '',
  ].filter(Boolean);
  return options.length ? `<div class="recovery-options" aria-label="Saved games">${options.join('')}</div>` : '';
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
    <p class="quiet-note">The host page must be open for play. If disconnected, the host restores the room first, then guests can rejoin. Codes are case-insensitive.</p>
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
          <button class="button button-secondary button-full copy-code-button" data-action="copy-room-code" type="button">Copy room code</button>
          ${!hostPeer && !creatingRoomCode ? '<button class="button button-secondary button-full" data-action="retry-host-room" type="button">Reconnect saved room</button>' : ''}`
        : `<p class="quiet-note">${creatingRoomCode ? 'Getting a room code…' : 'Could not connect to the room service.'}</p>
          ${creatingRoomCode ? '' : '<button class="button button-secondary" data-action="retry-room-code" type="button">Try again</button>'}`}
      <p class="quiet-note">Share it only with players in your game. Keep this page open during play; you can resume the saved room if interrupted.</p>
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
      <p class="quiet-note">Set each robot to Easy, Normal, or Hard. Higher difficulties consider wind risk and compare more moves.</p>
    </div>
    <div class="pair-area">
      ${connectedPlayers(state).length >= MIN_PLAYERS
        ? `<button class="button button-primary button-full start-button" data-action="start-game" type="button" ${creatingRoomCode || !hostRoomCode || !hostPeer ? 'disabled' : ''}>Start game <span aria-hidden="true">→</span></button>`
        : `<p class="quiet-note">Waiting for at least one guest. The host counts as a player.</p>`}
    </div>
    <details class="help-details"><summary>Connection notes</summary>    <p>Joining uses the PeerJS Cloud signaling service to find the room; gameplay uses a direct encrypted browser connection when the network allows it. Internet access is required for signaling. The room code is an invite—share it privately. iPhone may suspend a background tab, so keep the host page open in front. If the page closes, restore the host room before guests reconnect.</p></details>
  </section>`;
}

function renderGuest(): string {
  if (!guestState) {
    return `<section class="narrow-panel">
      <p class="eyebrow">GUEST CONNECTION</p><h1>Joining the<br /><em>skyline.</em></h1>
      <p class="lead-small">Connecting to the host. Keep this page open; the lobby will appear when the connection is ready.</p>
      ${guestResumeToken && !guestConnecting ? '<button class="button button-primary" data-action="retry-guest" type="button">Reconnect to saved game</button>' : ''}
      <button class="button button-secondary" data-action="cancel-guest" type="button">Leave</button>
    </section>`;
  }
  if (guestState.status === 'lobby') {
    return `<section class="game-panel">
      <div class="section-heading"><div><p class="eyebrow">CONNECTED TO HOST</p><h1>Waiting for<br /><em>liftoff.</em></h1></div><span class="pill">${guestState.players.length}/${MAX_PLAYERS} players</span></div>
      <p class="lead-small">Win target: <strong>${guestState.targetPoints} points</strong></p>
      <div class="player-list">${guestState.players.map((player) => playerMarkup(player, false)).join('')}</div>
      <p class="lead-small">The host will start the game when everyone is ready. Keep this page open.</p>
      ${!guestChannel?.open && guestResumeToken ? '<section class="resolution-card"><p class="lead-small">Connection to the host was lost. Your saved player identity is ready to reconnect.</p><button class="button button-primary" data-action="retry-guest" type="button">Reconnect to game</button></section>' : ''}
      <button class="button button-secondary" data-action="cancel-guest" type="button">Leave game</button>
    </section>`;
  }
  const reconnect = !guestChannel?.open && guestResumeToken
    ? '<section class="resolution-card"><p class="lead-small">Connection to the host was lost. Your saved player identity is ready to reconnect.</p><button class="button button-primary" data-action="retry-guest" type="button">Reconnect to game</button></section>'
    : '';
  return `${renderGame(guestState, false)}${reconnect}`;
}

function playerMarkup(player: Player, hostControls: boolean): string {
  const me = player.id === (screen === 'host' ? hostId : guestId);
  const hostPlayerId = hostState?.players[0]?.id ?? guestState?.players[0]?.id;
  const botDifficultyControl = hostControls && player.isBot && hostState?.status === 'lobby'
    ? `<label class="bot-difficulty-control"><span class="sr-only">${escapeHtml(player.name)} ${localizeText('Bot difficulty', language)}</span><select class="bot-difficulty-select" data-bot-difficulty="${escapeHtml(player.id)}">${BOT_DIFFICULTY_OPTIONS.map(({ value, label }) =>
      `<option value="${value}" ${(player.botDifficulty ?? 'normal') === value ? 'selected' : ''}>${localizeText(label, language)}</option>`,
    ).join('')}</select></label>`
    : '';
  return `<article class="player-row ${player.connected ? '' : 'player-offline'} ${botDifficultyControl ? 'player-row-bot' : ''}">
    <span class="player-avatar" aria-hidden="true">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>
    <span class="player-name">${escapeHtml(player.name)}${me ? ' <span class="you-tag">YOU</span>' : ''}${player.id === hostPlayerId ? ' <span class="host-tag">HOST</span>' : ''}<span class="room-win-tag">${player.roomWins} room win${player.roomWins === 1 ? '' : 's'}</span></span>
    <span class="player-meta">${player.isBot ? 'Robot' : player.connected ? 'Connected' : 'Disconnected'}</span>
    ${botDifficultyControl}
    ${hostControls && player.isBot ? `<button class="text-button danger-text" data-action="remove-robot" data-player="${escapeHtml(player.id)}" type="button">Remove</button>` : ''}
    ${hostControls && player.id !== hostId && !player.connected ? `<button class="text-button danger-text" data-action="remove-player" data-player="${escapeHtml(player.id)}" type="button">Remove</button>` : ''}
  </article>`;
}

function roundRollBarMarkup(state: MatchState, readyCount: number, isHost: boolean): string {
  const latestRound = state.history.at(-1);
  const showRoundScores = state.status === 'resolution' || state.status === 'finished';
  if (animatedRollRound !== state.round) {
    animatedRollRound = state.round;
    animatedRollPlayers.clear();
  }
  return `<section class="round-roll-bar" aria-label="Player rolls and round scores">
    <div class="round-roll-heading"><strong>PLAYER ROLLS &amp; SCORES</strong><span>${readyCount}/${state.players.length} moves submitted</span></div>
    <div class="round-roll-results" style="--player-columns:${Math.min(state.players.length, 5)}">${state.players.map((player) => {
      const roll = state.roundTurnRolls.find((turn) => turn.playerId === player.id);
      const animateRoll = !!roll && !animatedRollPlayers.has(player.id);
      if (animateRoll) animatedRollPlayers.add(player.id);
      const result = roll
        ? `<span class="round-roll-die ${animateRoll ? 'round-roll-die-rolling' : ''}">${dieMarkup(roll.die)}</span><small>${localizeText(`${roll.die} pips · ${roll.choice === 'choose' ? 'choosing' : roll.choice}`, language)}</small>`
          : '<span class="round-roll-pending">—</span><small>Choosing</small>';
      const pointsEarned = showRoundScores
        ? latestRound?.pointsEarned?.find((entry) => entry.playerId === player.id)?.points
        : undefined;
      const score = `<span class="round-roll-player-score"><strong>${player.score}</strong><small>PTS TOTAL</small></span>`;
      const roundScore = pointsEarned === undefined
        ? ''
        : `<small class="round-roll-score" aria-label="${pointsEarned} points this round">${pointsEarned > 0 ? '+' : ''}${pointsEarned} pts</small>`;
      const removePlayer = isHost && player.id !== hostId && !player.connected
        ? `<button class="text-button danger-text" data-action="remove-player" data-player="${escapeHtml(player.id)}" type="button">Remove disconnected player</button>`
        : '';
      return `<article class="round-roll-entry ${roll ? 'round-roll-ready' : ''}" title="${escapeHtml(player.name)}">
        <strong>${escapeHtml(player.name)}${!player.connected ? ' · OFFLINE' : ''}</strong>${result}${score}${roundScore}${removePlayer}
      </article>`;
    }).join('')}</div>
  </section>`;
}

function renderGame(state: MatchState, isHost: boolean): string {
  const playerId = isHost ? hostId : guestId;
  const me = state.players.find((player) => player.id === playerId);
  const myRoll = state.roundTurnRolls.find((turn) => turn.playerId === playerId);
  const rollReveal = playerRollReveal?.key === `${state.round}:${playerId}` && myRoll
    ? `<div class="die-roll-overlay" role="status" aria-live="polite" aria-atomic="true">
        <div class="die-roll-splash">
          <span class="eyebrow">${localizeText('YOUR ROLL', language)}</span>
          <strong class="die-roll-player">${escapeHtml(playerRollReveal.playerName)}</strong>
          <div class="die-roll-fullscreen-die round-roll-die-rolling">${dieMarkup(playerRollReveal.die, localizeText(`You rolled ${playerRollReveal.die}`, language))}</div>
          <h2>${localizeText(`You rolled ${playerRollReveal.die}`, language)}</h2>
        </div>
      </div>`
    : '';
  const isSubmitted = isHost ? submitted.has(hostId) : guestSubmitted;
  const awaitingMode = state.status === 'choice' && myRoll?.choice === 'choose' && !isSubmitted && !!me?.connected;
  const canBuild = state.status === 'choice' &&
    (myRoll?.choice === 'build' || (awaitingMode && selectedTurnMode === 'build')) &&
    !isSubmitted;
  const canBank = state.status === 'choice' &&
    (myRoll?.choice === 'bank' || (awaitingMode && selectedTurnMode === 'bank')) &&
    !isSubmitted;
  const latestRound = state.history.at(-1);
  const choices = awaitingMode && selectedTurnMode === null
      ? `<div class="action-card turn-choice-card"><p class="eyebrow">YOUR ROLL</p><h2>Build or bank?</h2><p>${localizeText(`You rolled ${myRoll.die}`, language)}</p><div class="turn-choice-buttons"><button class="button button-primary" data-action="choose-build" type="button">Build <small>${localizeText(`${myRoll.die} floors`, language)}</small></button><button class="button button-secondary" data-action="choose-bank" type="button" ${me?.towers.length ? '' : 'disabled'}>Bank <small>${localizeText(`Up to ${myRoll.die} towers`, language)}</small></button></div></div>`
      : state.status === 'choice' && isSubmitted
      ? `<div class="wait-card"><span class="spinner" aria-hidden="true"></span><div><strong>Your move is locked in.</strong><p>Waiting for every player before the shared wind.</p></div></div>`
      : '';
  const toppleAnimation = state.dice !== null && latestRound?.toppled.length
    ? `<div class="topple-animation">
        <span class="falling-tower" aria-hidden="true">▥</span>
        <strong>The wind toppled ${latestRound.toppled.length} tower${latestRound.toppled.length === 1 ? '' : 's'}!</strong>
      </div>`
    : '';
  const windResult = state.dice !== null
    ? `<div class="round-wind-result" role="img" aria-label="Shared wind: ${state.dice[0]} plus ${state.dice[1]} equals ${state.dice[0] + state.dice[1]}">
        <span>WIND TOTAL</span><div class="dice-pair">${dieMarkup(state.dice[0])}<b>+</b>${dieMarkup(state.dice[1])}</div><b>=</b><strong>${state.dice[0] + state.dice[1]}</strong>
      </div>`
    : '';
  const reconnectHost = isHost && hostRoomCode && !hostPeer && !creatingRoomCode
    ? '<section class="resolution-card"><p class="lead-small">The room is not connected to the signaling service.</p><button class="button button-primary" data-action="retry-host-room" type="button">Reconnect saved room</button></section>'
    : '';

  const rollCount = state.status === 'choice'
    ? isHost ? submitted.size : submittedCount
    : state.players.length;
  const winners = state.status === 'finished'
    ? state.players.filter((player) => state.winnerIds.includes(player.id))
    : [];
  const outcomeMarkup = state.status === 'resolution'
    ? `<section class="round-result-banner round-result-round ${isHost ? 'round-result-skippable' : ''}">
        <span class="round-result-mark" aria-hidden="true">✓</span>
        <div class="round-result-copy"><p class="eyebrow">ROUND ${state.round} COMPLETE</p><h2>The shared wind has passed.</h2><p>The next round starts automatically in ${ROUND_WIND_DISPLAY_MS / 1000} seconds.</p>${isHost ? `<p>${localizeText('Double-click or tap twice here to start now.', language)}</p>` : ''}</div>
        ${windResult}
        ${latestRound ? fallSummaryMarkup(latestRound, state, playerId) : ''}
      </section>`
    : state.status === 'finished'
      ? `<section class="round-result-banner round-result-winner">
          <span class="round-result-mark" aria-hidden="true">★</span>
          <div class="round-result-copy"><p class="eyebrow">GAME OVER · TARGET ${state.targetPoints}</p>
            <h2>${winners.length > 1 ? 'Shared victory!' : `${escapeHtml(winners[0]?.name ?? 'A player')} wins!`}</h2>
            <div class="winner-result-list">${winners.map((winner) => `<span><strong>${escapeHtml(winner.name)}</strong><b>${winner.score} pts</b></span>`).join('')}</div>
            <p class="winner-reward">${winners.length > 1 ? 'Each winner earns one room win.' : 'The winner earns one room win.'}</p>
          </div>
          ${windResult}
          ${latestRound ? fallSummaryMarkup(latestRound, state, playerId) : ''}
          ${isHost
            ? `<div class="rematch-actions"><button class="button button-primary button-full" data-action="rematch" type="button" ${state.players.length < MIN_PLAYERS || state.players.some((player) => !player.connected) ? 'disabled' : ''}>Play again in this room</button><button class="button button-secondary button-full" data-action="return-lobby" type="button">Return to room lobby</button></div>`
            : '<p class="quiet-note">The host can start another game in this room or return to the lobby.</p>'}
        </section>`
      : '';

  return `<section class="game-panel board-panel">
    ${me ? towerBoardMarkup(me, state, canBank, canBuild, isSubmitted) : ''}
    ${roundRollBarMarkup(state, rollCount, isHost)}
    <div class="section-heading"><div><p class="eyebrow">${state.status === 'finished' ? 'GAME OVER' : `ROUND ${state.round} · PARALLEL TURNS`}</p><h1>${state.status === 'finished' ? 'The skyline is <em>set.</em>' : state.status === 'resolution' ? 'The shared wind has <em>passed.</em>' : 'Everyone’s <em>turn.</em>'}</h1></div>
    </div>
    ${state.status === 'choice' ? `<p class="lead-small">Reach ${state.targetPoints} points to win. ${localizeText('Your die is rolled automatically; then choose to build or bank. Use the result as your building budget or bank up to that many towers.', language)}</p>` : ''}
    ${reconnectHost}
    ${choices}
    ${toppleAnimation}
    ${outcomeMarkup}
    ${state.status !== 'finished' ? `<details class="help-details"><summary>Rules &amp; wind limits</summary>${rulesMarkup()}</details>` : ''}
    ${rollReveal}
  </section>`;
}

function dieMarkup(value: number, label = `Die shows ${value}`): string {
  const positions: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  return `<span class="die" aria-label="${escapeHtml(label)}">${Array.from({ length: 9 }, (_, index) => `<i class="${positions[value]?.includes(index) ? 'die-dot' : ''}"></i>`).join('')}</span>`;
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
  canBank: boolean,
  canBuild: boolean,
  isSubmitted: boolean,
): string {
  const wind = state.dice ? state.dice[0] + state.dice[1] : null;
  const turnDie = state.roundTurnRolls.find((turn) => turn.playerId === player.id)?.die ?? 0;
  const building = canBuild;
  const banking = canBank;
  const showBuildChanges = building || (isSubmitted &&
    state.roundTurnRolls.some((turn) => turn.playerId === player.id && turn.choice === 'build'));
  const spent = showBuildChanges
    ? Array.from(selectedAllocations.values()).reduce((sum, value) => sum + value, 0)
    : 0;
  const pendingTowerCount = showBuildChanges
    ? Array.from(selectedAllocations.keys()).filter((key) => key.startsWith('new-')).length
    : 0;
  const windShield = state.status === 'resolution'
    ? state.history.at(-1)?.windShields[player.id] ?? towerShield(player.towers.length)
    : towerShield(player.towers.length + pendingTowerCount);
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
    const additionalHeight = showBuildChanges ? selectedAllocations.get(tower.id) ?? 0 : 0;
    const height = tower.height + additionalHeight;
    const limit = heightLimit(height) + windShield;
    const atRisk = wind !== null && wind >= limit;
    const selected = banking && selectedBankTowerIds.has(tower.id);
    const disabled = tower.toppled ||
      (!building && !banking) ||
      (building && !hasFloorBudget) ||
      (banking && !selected && selectedBankTowerIds.size >= turnDie);
    const worth = towerPoints(height);
    return `<div class="tower-slot-card">
      <button class="tower-slot ${selected ? 'tower-slot-selected' : ''} ${additionalHeight ? 'tower-slot-pending' : ''}" data-action="tower-slot" data-slot="${escapeHtml(tower.id)}" type="button" aria-pressed="${selected}" aria-label="${tower.toppled ? 'Toppled tower' : 'Tower'}, height ${height}, worth ${worth} points" ${disabled ? 'disabled' : ''}>
        <span class="tower-body">
          <span class="tower-visual ${atRisk ? 'tower-visual-risk' : ''} ${tower.toppled ? 'tower-visual-toppled' : ''}" aria-hidden="true">${floorsMarkup(height)}</span>
          ${tower.toppled ? '' : windScaleMarkup(limit, wind)}
        </span>
        <span class="tower-points-label ${tower.toppled ? 'tower-toppled-label' : ''}">${tower.toppled ? 'TOPPLED' : `${worth} pts`}</span>
      </button>${undoButton(tower.id, additionalHeight)}
    </div>`;
  };
  const emptyTowerSlot = (index: number) => {
    const key = `new-${index}`;
    const height = showBuildChanges ? selectedAllocations.get(key) : undefined;
    const pending = height !== undefined;
    const disabled = pending ? !hasFloorBudget : !canAddNewTower;
    const limit = pending
      ? heightLimit(height) + windShield
      : 0;
    const atRisk = pending && wind !== null && wind >= limit;
    const worth = pending ? towerPoints(height) : 0;
    const accessibleLabel = pending
      ? `New tower, height ${height}, worth ${worth} points`
      : 'Empty tower slot, worth 0 points';
    return `<div class="tower-slot-card">
      <button class="tower-slot ${pending ? 'tower-slot-pending' : 'tower-slot-placeholder'}" data-action="tower-slot" data-slot="${key}" type="button" aria-label="${accessibleLabel}" ${disabled ? 'disabled' : ''}>
        <span class="tower-body">
          <span class="tower-visual ${pending && atRisk ? 'tower-visual-risk' : ''} ${pending ? '' : 'tower-visual-empty'}" aria-hidden="true">${pending ? floorsMarkup(height) : '<span>＋</span>'}</span>
          ${pending ? windScaleMarkup(limit, wind) : ''}
        </span>
        <span class="tower-points-label">${worth} pts</span>
      </button>${undoButton(key, height ?? 0)}
    </div>`;
  };
  const towersBySlot = new Map(player.towers.map((tower, index) => [tower.slot ?? index, tower]));
  const towerSlots = Array.from({ length: MAX_TOWERS }, (_, slot) => {
    const tower = towersBySlot.get(slot);
    return tower ? existingTowerSlot(tower) : emptyTowerSlot(slot);
  }).join('');
  const selectedBankTowers = player.towers.filter((tower) => selectedBankTowerIds.has(tower.id));
  const selectedBankPoints = selectedBankTowers.reduce((total, tower) => total + towerPoints(tower.height), 0);
  const canCommit = building
    ? spent > 0 && spent <= turnDie && player.towers.length + pendingTowerCount <= MAX_TOWERS
    : banking && selectedBankTowers.length > 0 && selectedBankTowers.length <= turnDie;
  const hasControls = building || banking;
  const commitLabel = banking && selectedBankTowers.length > 0
    ? localizeText(`Bank ${selectedBankTowers.length} tower${selectedBankTowers.length === 1 ? '' : 's'} for +${selectedBankPoints} points`, language)
    : 'Place floors and face the wind';
  return `<section class="tower-board-panel ${building ? 'tower-board-building' : ''}" aria-label="Your towers">
    <div class="tower-board-heading"><div><p class="eyebrow">YOUR SKYLINE</p><h2>Your towers</h2></div><span>${player.towers.length + pendingTowerCount}/${MAX_TOWERS} towers · ${player.bankedTowers} banked</span></div>
    <div class="tower-board">${towerSlots}</div>
    <div class="wind-scale-legend" aria-label="Wind scale legend"><span><i class="wind-mark wind-mark-safe"></i>Safe</span><span><i class="wind-mark wind-mark-danger"></i>Topples</span><span class="wind-scale-range">2 ↑ 12</span></div>
    ${banking && player.towers.length === 0 ? '<p class="quiet-note">You have no towers to bank. Choose building instead.</p>' : ''}
    ${hasControls ? `<div class="commit-move-panel"><p>${building ? `Floors added: <strong>${spent}/${turnDie}</strong>` : localizeText(`Selected: ${selectedBankTowers.length}/${turnDie} towers · +${selectedBankPoints} pts`, language)}</p><button class="button button-primary button-full" data-action="commit-move" type="button" ${canCommit ? '' : 'disabled'}>${commitLabel}</button><p class="quiet-note">${building ? `Click a tower to add floors; use Undo one to take a floor back. Start at most one new tower in an empty slot, up to ${MAX_TOWERS} standing towers.` : localizeText(`Choose up to ${turnDie} towers to bank. You may bank fewer than your roll.`, language)}</p><button class="text-button" data-action="${building ? 'switch-to-bank' : 'switch-to-build'}" type="button">${localizeText(`Choose ${building ? 'banking' : 'building'} instead`, language)}</button></div>` : ''}
  </section>`;
}

function fallSummaryMarkup(round: MatchState['history'][number], state: MatchState, viewerId: string): string {
  const affectedPlayers = state.players.filter((player) => (round.fallenCounts[player.id] ?? 0) > 0);
  if (affectedPlayers.length === 0) return '<p class="fall-summary-empty">No towers toppled this round.</p>';
  return `<ul class="fall-summary" aria-label="Players whose towers toppled">${affectedPlayers.map((player) => {
    const count = round.fallenCounts[player.id] ?? 0;
    const label = player.id === viewerId ? 'Your towers' : escapeHtml(player.name);
    return `<li><span>${label}</span><strong>${count} tower${count === 1 ? '' : 's'} toppled</strong></li>`;
  }).join('')}</ul>`;
}

function rulesMarkup(): string {
  return `<div class="rules-sections">
    <section class="rules-section"><h3>Goal and round flow</h3>
      <p>Reach the host's target of ${MIN_WIN_POINTS}–${MAX_WIN_POINTS} points (80 by default). At the start of each round, the host automatically rolls one die for every player. Then choose Build or Bank. After all moves are submitted, the host rolls the shared wind, scores banked towers, and checks every unbanked tower. The wind result stays visible for 8 seconds before the next round.</p>
    </section>
    <section class="rules-section"><h3>Build</h3>
      <p>${localizeText('Build uses up to your roll in floors across existing towers. You may spend less and can start at most one new tower in an empty slot.', language)} Use <strong>Undo one</strong> before submitting to remove a floor. You can have up to ${MAX_TOWERS} standing towers. Tower point values are shown below them.</p>
    </section>
    <section class="rules-section"><h3>Bank</h3>
      <p>${localizeText('Bank up to the number of towers shown by your die. You may choose fewer. Each banked tower scores height × (height + 1) ÷ 2 points and is protected from the wind.', language)}</p>
    </section>
    <section class="rules-section rules-wind-section"><h3>Wind and tower protection</h3>
      <p>The two shared dice are added together for a wind strength from 2 to 12. An unbanked tower topples when the wind reaches or exceeds its limit. Toppled towers turn red and remain visible through the round result, then disappear when the next round starts. Each standing tower beyond the first adds +1 protection to every tower, up to +${MAX_TOWER_SHIELD}. Protection is calculated before the wind tests the skyline.</p>
      <div class="limit-table"><span>Height</span><span>Topples at wind</span>${Array.from({ length: 11 }, (_, index) => index + 1).map((height) => `<b>${height === 11 ? '11+' : height}</b><b>${heightLimit(height)} or higher</b>`).join('')}</div>
    </section>
    <section class="rules-section"><h3>Winning</h3>
      <p>If a player reaches the target after a round resolves, the player with the highest score wins. Tied high scores share the victory and each winner earns one room win.</p>
    </section>
  </div>
  <p class="quiet-note">Everyone can see the rolls, total scores, round score changes, and shared wind. Opponents' tower layouts remain private.</p>`;
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
    if (!hostState) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'This room is no longer available.' }));
      return;
    }
    if (message.name.trim().length < 1 || message.name.length > 18 || message.playerId.length > 64) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'Please choose a name with 1–18 characters.' }));
      return;
    }
    if (message.resumeToken) {
      const player = hostState.players.find((item) => item.id === message.playerId && !item.isBot);
      if (
        !player ||
        player.name !== message.name.trim() ||
        hostResumeTokens.get(message.playerId) !== message.resumeToken
      ) {
        connection.channel.send(JSON.stringify({ type: 'error', message: 'This saved player cannot rejoin this room.' }));
        return;
      }
      connection.playerId = message.playerId;
      for (const previousConnection of hostConnections) {
        if (previousConnection !== connection && previousConnection.playerId === message.playerId) {
          hostConnections.delete(previousConnection);
          previousConnection.channel.close();
        }
      }
      player.connected = true;
      notice = `${player.name} rejoined the room.`;
      failure = '';
      broadcastState();
      render();
      return;
    }
    if (hostState.status !== 'lobby') {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'This room has already started.' }));
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
    hostResumeTokens.set(message.playerId, randomId());
    notice = `${message.name.trim()} joined the room.`;
    failure = '';
    broadcastState();
    render();
    return;
  }
  if (message.type === 'action') {
    if (
      !hostState ||
      hostState.status !== 'choice' ||
      connection.playerId !== message.playerId ||
      submitted.has(message.playerId)
    ) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'This move was already submitted or is not part of the active round.' }));
      return;
    }
    const player = hostState.players.find((item) => item.id === message.playerId);
    let actionState = hostState;
    let turn = actionState.roundTurnRolls.find((item) => item.playerId === message.playerId);
    if (turn?.choice === 'choose') {
      actionState = chooseTurnMode(actionState, message.playerId, message.action.kind);
      turn = actionState.roundTurnRolls.find((item) => item.playerId === message.playerId);
    }
    if (
      !player ||
      !turn ||
      turn.choice !== message.action.kind ||
      !isLegalAction(
        player,
        message.action,
        turn.choice === 'build' ? 'build' : 'choose',
        turn.die,
      )
    ) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'That action is not legal for the current turn.' }));
      return;
    }
    hostState = actionState;
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
    notice = 'A guest connection is ready.';
    render();
  });
  connection.channel.on('close', () => {
    hostConnections.delete(connection);
    const playerId = connection.playerId;
    if (!playerId || !hostState) return;
    if (Array.from(hostConnections).some((item) => item.playerId === playerId && item.channel.open)) return;
    const player = hostState.players.find((item) => item.id === playerId);
    if (!player) return;
    player.connected = false;
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
        ...(hostResumeTokens.has(connection.playerId)
          ? { resumeToken: hostResumeTokens.get(connection.playerId)! }
          : {}),
        isSubmitted: submitted.has(connection.playerId),
      }));
    }
  }
}

function submitBotActions(): void {
  if (!hostState || hostState.status !== 'choice') return;
  for (const player of hostState.players) {
    if (!player.isBot || submitted.has(player.id)) continue;
    const turn = hostState.roundTurnRolls.find((item) => item.playerId === player.id);
    if (!turn || turn.choice !== 'choose') continue;
    const turnDie = turn.die;
    const choice = chooseBotTurnChoice(player, hostState.targetPoints, turnDie);
    hostState = chooseTurnMode(hostState, player.id, choice.kind);
    if (choice.kind === 'bank') {
      submitted.set(player.id, choice);
    } else {
      submitted.set(player.id, chooseBotBuildAction(player, turnDie));
    }
  }
}

function rollPendingTurns(): void {
  if (!hostState || hostState.status !== 'choice') return;
  for (const player of hostState.players) {
    if (hostState.roundTurnRolls.some((turn) => turn.playerId === player.id)) continue;
    const die = rollTurnDie();
    hostState = beginTurnRoll(hostState, player.id, die);
    if (player.id === hostId) revealPlayerRoll(hostState.round, player.id, player.name, die);
  }
  submitBotActions();
}

function maybeResolveRound(): void {
  if (!hostState || hostState.status !== 'choice') {
    broadcastState();
    render();
    return;
  }
  submittedCount = submitted.size;
  const allSubmitted = hostState.players.every((player) =>
    submitted.has(player.id) &&
    hostState!.roundTurnRolls.some((turn) => turn.playerId === player.id));
  if (!allSubmitted) {
    broadcastState();
    render();
    return;
  }
  broadcastState();
  render();
  if (hostState.players.some((player) => player.isBot) && botResolveTimer === null) {
    botResolveTimer = window.setTimeout(() => {
      botResolveTimer = null;
      resolveSubmittedRound();
    }, BOT_TURN_DELAY_MS);
    return;
  }
  if (botResolveTimer === null) resolveSubmittedRound();
}

function resolveSubmittedRound(): void {
  if (
    !hostState ||
    hostState.status !== 'choice' ||
    !hostState.players.every((player) => submitted.has(player.id))
  ) {
    return;
  }
  try {
    const actions = hostState.players.map((player) => {
      const action = submitted.get(player.id);
      if (!action) throw new Error(`${player.name} has not submitted a turn.`);
      return { playerId: player.id, action };
    });
    hostState = resolveRound(hostState, actions, rollDice());
    submitted.clear();
    submittedCount = 0;
    selectedAllocations.clear();
    selectedBankTowerIds.clear();
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
  lastRoundSkipPressAt = null;
  lastRoundSkipPressRound = null;
  autoRollTimer = window.setTimeout(() => {
    autoRollTimer = null;
    advanceToNextRound();
  }, ROUND_WIND_DISPLAY_MS);
}

function advanceToNextRound(): void {
  if (screen !== 'host' || !hostState || hostState.status !== 'resolution') return;
  if (autoRollTimer !== null) window.clearTimeout(autoRollTimer);
  autoRollTimer = null;
  lastRoundSkipPressAt = null;
  lastRoundSkipPressRound = null;
  hostState = beginNextRound(hostState);
  submitted.clear();
  submittedCount = 0;
  selectedAllocations.clear();
  selectedBankTowerIds.clear();
  selectedTurnMode = null;
  rollPendingTurns();
  maybeResolveRound();
}

function commitAction(playerId: string, action: PlayerAction): void {
  let state = currentState();
  if (
    !state ||
    state.status !== 'choice' ||
    (screen === 'host' && submitted.has(playerId)) ||
    guestSubmitted
  ) return;
  let turn = state.roundTurnRolls.find((item) => item.playerId === playerId);
  if (turn?.choice === 'choose') {
    state = chooseTurnMode(state, playerId, action.kind);
    turn = state.roundTurnRolls.find((item) => item.playerId === playerId);
  }
  const player = state.players.find((item) => item.id === playerId);
  if (
    !player ||
    !turn ||
    turn.choice !== action.kind ||
    !isLegalAction(player, action, turn.choice === 'build' ? 'build' : 'choose', turn.die)
  ) {
    showFailure('That action is no longer available. Choose an eligible tower and try again.');
    return;
  }
  selectedBankTowerIds.clear();
  selectedTurnMode = null;
  if (screen === 'host') {
    hostState = state;
    submitted.set(playerId, action);
    submittedCount = submitted.size;
    maybeResolveRound();
  } else {
    if (!guestChannel?.open) {
      submitted.delete(playerId);
      showFailure('The host connection is unavailable. Reconnect before submitting your turn.');
      return;
    }
    selectedBankTowerIds.clear();
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

async function createHostPeer(requestedRoomCode?: string): Promise<void> {
  if (!hostState || creatingRoomCode) return;
  creatingRoomCode = true;
  hostPeer?.destroy();
  hostPeer = null;
  hostRoomCode = requestedRoomCode ?? '';
  const generation = roomGeneration;
  render();
  try {
    const attempts = requestedRoomCode ? 15 : 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const code = requestedRoomCode ?? createRoomCode();
      const peer = new Peer(code, PEER_OPTIONS);
      hostPeer = peer;
      try {
        await waitForPeerOpen(peer);
      } catch (error) {
        peer.destroy();
        if (hostPeer === peer) hostPeer = null;
        if (generation !== roomGeneration) return;
        if (error instanceof PeerError && error.type === PeerErrorType.UnavailableID) {
          if (requestedRoomCode && attempt < attempts - 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          }
          continue;
        }
        throw error;
      }
      if (generation !== roomGeneration) {
        peer.destroy();
        if (hostPeer === peer) hostPeer = null;
        return;
      }
      hostRoomCode = code;
      peer.on('connection', (channel) => {
        if (hostPeer !== peer || !hostState) {
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
          showFailure('The room service connection was lost. Reconnecting the room service now.');
          peer.reconnect();
        }
      });
      notice = requestedRoomCode ? 'Saved room restored. Guests can reconnect now.' : 'Room ready. Share the code with your guests.';
      failure = '';
      if (requestedRoomCode) {
        if (hostState.status === 'resolution') {
          broadcastState();
          scheduleAutomaticNextRound();
        } else if (hostState.status === 'choice') {
          rollPendingTurns();
          maybeResolveRound();
        } else {
          broadcastState();
        }
      }
      return;
    }
    throw new Error(requestedRoomCode
      ? 'The saved room code is still in use. Wait a little and try resuming again.'
      : 'Could not reserve a unique room code. Try again.');
  } catch (error) {
    if (generation === roomGeneration) {
      hostPeer?.destroy();
      hostPeer = null;
      if (!requestedRoomCode) hostRoomCode = '';
      showFailure(peerFailureMessage(error, 'host'));
    }
  } finally {
    if (generation === roomGeneration) {
      creatingRoomCode = false;
      render();
    }
  }
}

function connectGuest(roomCode: string, recovery?: GuestRecoveryRecord): void {
  const peer = new Peer(PEER_OPTIONS);
  guestPeer = peer;
  guestState = null;
  guestConnecting = true;
  guestSubmitted = false;
  selectedAllocations.clear();
  selectedBankTowerIds.clear();
  selectedTurnMode = null;
  clearPlayerRollReveal();
  animatedRollRound = 0;
  animatedRollPlayers.clear();
  guestRoomCode = roomCode;
  guestId = recovery?.playerId ?? randomId();
  guestResumeToken = recovery?.resumeToken ?? '';
  if (recovery) guestName = recovery.playerName;
  screen = 'guest';
  notice = 'Connecting to the room…';
  failure = '';
  render();
  void waitForPeerOpen(peer).then(() => {
    if (guestPeer !== peer) return;
    peer.on('error', (error) => {
      if (guestPeer === peer) {
        guestConnecting = false;
        showFailure(peerFailureMessage(error, 'guest'));
      }
    });
    peer.on('disconnected', () => {
      if (guestPeer === peer) {
        showFailure('The room service connection was lost. Reconnecting the room service now.');
        peer.reconnect();
      }
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
      channel.send(JSON.stringify({
        type: 'join',
        playerId: guestId,
        name: guestName,
        ...(guestResumeToken ? { resumeToken: guestResumeToken } : {}),
      }));
      notice = 'Connected to the host. Joining the lobby…';
      render();
    });
    channel.on('data', (data: unknown) => {
      try {
        if (typeof data !== 'string') throw new Error('Received an invalid game message.');
        const message = parseMessage(data);
        if (message.type === 'state' && message.playerId === guestId) {
          guestConnecting = false;
          const previousStatus = guestState?.status;
          const previousRound = guestState?.round;
          const previousRoll = guestState?.roundTurnRolls.find((turn) => turn.playerId === guestId);
          guestState = message.state;
          submittedCount = message.submittedCount;
          const currentRoll = guestState.roundTurnRolls.find((turn) => turn.playerId === guestId);
          if (guestState.status === 'choice' && previousStatus !== 'choice') {
            clearPlayerRollReveal();
            animatedRollRound = 0;
            animatedRollPlayers.clear();
          }
          const currentPlayer = guestState.players.find((player) => player.id === guestId);
          if (
            currentRoll &&
            currentPlayer &&
            (guestState.round !== previousRound || currentRoll.die !== previousRoll?.die)
          ) {
            revealPlayerRoll(guestState.round, guestId, currentPlayer.name, currentRoll.die);
          }
          if (
            guestState.status !== 'choice' ||
            guestState.round !== previousRound ||
            currentRoll?.choice !== previousRoll?.choice ||
            currentRoll?.die !== previousRoll?.die
          ) {
            guestSubmitted = false;
            selectedAllocations.clear();
            selectedBankTowerIds.clear();
            selectedTurnMode = null;
          }
          guestSubmitted = message.isSubmitted ?? guestSubmitted;
          if (message.resumeToken) guestResumeToken = message.resumeToken;
          failure = '';
          notice = '';
          screen = 'guest';
          render();
        } else if (message.type === 'error') {
          guestConnecting = false;
          showFailure(message.message);
        }
      } catch (error) {
        showFailure(error instanceof Error ? error.message : 'Could not read the host update.');
      }
    });
    channel.on('close', () => {
      window.clearTimeout(timeout);
      if (guestPeer !== peer) return;
      guestConnecting = false;
      showFailure(guestState
        ? 'The host connection closed. If the host restores the room, you can reconnect from this device.'
        : 'The connection closed before joining. Check the room code and try again.');
    });
    channel.on('error', (error) => {
      window.clearTimeout(timeout);
      if (guestPeer === peer) {
        guestConnecting = false;
        showFailure(peerFailureMessage(error, 'guest'));
      }
    });
  }).catch((error: unknown) => {
    if (guestPeer !== peer) return;
    guestConnecting = false;
    peer.destroy();
    guestPeer = null;
    guestChannel = null;
    showFailure(peerFailureMessage(error, 'guest'));
  });
}

function retryGuestRoom(): void {
  if (!guestRoomCode || !guestId || !guestResumeToken) {
    throw new Error('There is no saved guest identity to reconnect.');
  }
  const recovery: GuestRecoveryRecord = {
    version: 1,
    roomCode: guestRoomCode,
    playerId: guestId,
    playerName: guestName,
    resumeToken: guestResumeToken,
  };
  const previousPeer = guestPeer;
  guestPeer = null;
  guestChannel = null;
  previousPeer?.destroy();
  connectGuest(guestRoomCode, recovery);
}

async function resumeHostRoom(): Promise<void> {
  const recovery = hostRecoveryAvailable;
  if (!recovery) throw new Error('There is no saved host room to resume.');
  if (autoRollTimer !== null) window.clearTimeout(autoRollTimer);
  if (botResolveTimer !== null) window.clearTimeout(botResolveTimer);
  autoRollTimer = null;
  botResolveTimer = null;
  hostId = recovery.hostId;
  playerName = recovery.playerName;
  hostState = recovery.state;
  clearPlayerRollReveal();
  hostRoomCode = recovery.roomCode;
  submitted = new Map(recovery.submitted);
  submittedCount = submitted.size;
  hostResumeTokens = new Map(Object.entries(recovery.resumeTokens));
  for (const player of hostState.players) {
    player.connected = player.id === hostId || player.isBot === true;
  }
  guestState = null;
  screen = 'host';
  hostFormVisible = false;
  hostRecoveryAvailable = null;
  notice = 'Restoring your saved room…';
  failure = '';
  await createHostPeer(recovery.roomCode);
}

function discardRecovery(role: 'host' | 'guest' | 'all'): void {
  const keys = role === 'all'
    ? [HOST_RECOVERY_KEY, GUEST_RECOVERY_KEY]
    : [role === 'host' ? HOST_RECOVERY_KEY : GUEST_RECOVERY_KEY];
  try {
    for (const key of keys) window.localStorage.removeItem(key);
  } catch (error) {
    throw new Error(`Could not clear saved recovery data. ${error instanceof Error ? error.message : ''}`.trim());
  }
  if (role === 'host' || role === 'all') hostRecoveryAvailable = null;
  if (role === 'guest' || role === 'all') guestRecoveryAvailable = null;
  if (role === 'all') recoveryReadError = false;
  showNotice('Saved game recovery data cleared.');
}

function removePlayer(playerId: string): void {
  if (!hostState || playerId === hostId) return;
  const player = hostState.players.find((item) => item.id === playerId);
  if (!player) return;
  hostResumeTokens.delete(playerId);
  hostState.players = hostState.players.filter((item) => item.id !== playerId);
  hostState.roundTurnRolls = hostState.roundTurnRolls.filter((turn) => turn.playerId !== playerId);
  submitted.delete(playerId);
  for (const connection of hostConnections) {
    if (connection.playerId === playerId) {
      hostConnections.delete(connection);
      connection.channel.close();
    }
  }
  notice = `${player.name} was removed from the room.`;
  broadcastState();
  if (hostState.status === 'choice') {
    rollPendingTurns();
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
    botDifficulty: 'normal',
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
  const recoveryRole = screen === 'host' ? 'host' : screen === 'guest' ? 'guest' : null;
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
  hostResumeTokens.clear();
  guestPeer?.destroy();
  guestPeer = null;
  guestChannel = null;
  guestConnecting = false;
  guestRoomCode = '';
  guestResumeToken = '';
  submitted.clear();
  submittedCount = 0;
  guestSubmitted = false;
  selectedAllocations.clear();
  selectedBankTowerIds.clear();
  screen = 'home';
  notice = '';
  failure = '';
  if (recoveryRole) {
    if (recoveryRole === 'host') hostRecoveryAvailable = null;
    else guestRecoveryAvailable = null;
    try {
      window.localStorage.removeItem(recoveryRole === 'host' ? HOST_RECOVERY_KEY : GUEST_RECOVERY_KEY);
    } catch (error) {
      failure = `Could not clear saved recovery data. ${error instanceof Error ? error.message : ''}`.trim();
    }
  }
  render();
}

app.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.id === 'language-select') {
    if (!isLanguage(target.value)) return;
    const formValues = {
      hostName: app?.querySelector<HTMLInputElement>('#host-name')?.value,
      guestName: app?.querySelector<HTMLInputElement>('#guest-name')?.value,
      guestRoomCode: app?.querySelector<HTMLInputElement>('#guest-room-code')?.value,
      targetPoints: app?.querySelector<HTMLInputElement>('#target-points')?.value,
    };
    language = target.value;
    try {
      window.localStorage.setItem(LANGUAGE_PREFERENCE_KEY, language);
      failure = '';
    } catch {
      failure = 'Could not save the language preference in this browser.';
      notice = '';
    }
    render();
    const hostName = app?.querySelector<HTMLInputElement>('#host-name');
    const guestNameField = app?.querySelector<HTMLInputElement>('#guest-name');
    const guestRoomCode = app?.querySelector<HTMLInputElement>('#guest-room-code');
    const targetPoints = app?.querySelector<HTMLInputElement>('#target-points');
    if (hostName && formValues.hostName !== undefined) hostName.value = formValues.hostName;
    if (guestNameField && formValues.guestName !== undefined) guestNameField.value = formValues.guestName;
    if (guestRoomCode && formValues.guestRoomCode !== undefined) guestRoomCode.value = formValues.guestRoomCode;
    if (targetPoints && formValues.targetPoints !== undefined) targetPoints.value = formValues.targetPoints;
    return;
  }
  if (target instanceof HTMLSelectElement && target.dataset.botDifficulty !== undefined) {
    if (!hostState || hostState.status !== 'lobby') {
      showFailure('Bot difficulty can only be changed in the lobby.');
      return;
    }
    const robot = hostState.players.find((player) =>
      player.id === target.dataset.botDifficulty && player.isBot);
    if (!robot) {
      showFailure('This robot is no longer in the lobby.');
      return;
    }
    if (!isBotDifficulty(target.value)) {
      showFailure('Choose a valid bot difficulty.');
      return;
    }
    robot.botDifficulty = target.value;
    broadcastState();
    render();
    return;
  }
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
  const roundResult = target.closest<HTMLElement>('.round-result-skippable');
  if (roundResult) {
    if (screen !== 'host' || !hostState || hostState.status !== 'resolution') return;
    const now = Date.now();
    if (
      lastRoundSkipPressAt !== null &&
      lastRoundSkipPressRound === hostState.round &&
      now - lastRoundSkipPressAt <= ROUND_SKIP_DOUBLE_PRESS_MS
    ) {
      advanceToNextRound();
    } else {
      lastRoundSkipPressAt = now;
      lastRoundSkipPressRound = hostState.round;
    }
    return;
  }
  const button = target.closest<HTMLButtonElement>('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'dismiss-notice') {
      dismissNotification();
    } else if (action === 'home') {
      if (screen === 'host' || screen === 'guest') {
        const leave = window.confirm(localizeText('Leave this room? The active match will end for this device.', language));
        if (!leave) return;
        resetRoom();
        return;
      }
      screen = 'home';
      render();
    } else if (action === 'show-host-form') {
      hostFormVisible = true;
      render();
      app.querySelector<HTMLInputElement>('#host-name')?.focus();
    } else if (action === 'show-guest') {
      hostFormVisible = false;
      screen = 'guest-setup';
      render();
    } else if (action === 'resume-host') {
      await resumeHostRoom();
    } else if (action === 'resume-guest') {
      const recovery = guestRecoveryAvailable;
      if (!recovery) throw new Error('There is no saved guest game to rejoin.');
      connectGuest(recovery.roomCode, recovery);
    } else if (action === 'discard-host-recovery') {
      discardRecovery('host');
    } else if (action === 'discard-guest-recovery') {
      discardRecovery('guest');
    } else if (action === 'discard-recovery') {
      discardRecovery('all');
    } else if (action === 'copy-room-code') {
      await copyCode('#host-room-code', 'Room code copied.');
    } else if (action === 'retry-room-code') {
      await createHostPeer();
    } else if (action === 'retry-host-room') {
      if (!hostRoomCode) throw new Error('There is no saved room code to reconnect.');
      await createHostPeer(hostRoomCode);
    } else if (action === 'retry-guest') {
      retryGuestRoom();
    } else if (action === 'add-robot') {
      addRobot();
    } else if (action === 'remove-robot' && button.dataset.player) {
      removeRobot(button.dataset.player);
    } else if (action === 'choose-build' || action === 'switch-to-build') {
      selectedTurnMode = 'build';
      selectedBankTowerIds.clear();
      selectedAllocations.clear();
      render();
    } else if (action === 'switch-to-bank') {
      selectedTurnMode = 'bank';
      selectedBankTowerIds.clear();
      selectedAllocations.clear();
      render();
    } else if (action === 'choose-bank') {
      selectedTurnMode = 'bank';
      selectedBankTowerIds.clear();
      selectedAllocations.clear();
      render();
    } else if (action === 'undo-floor' && button.dataset.slot) {
      const state = currentState();
      const playerId = screen === 'host' ? hostId : guestId;
      const turn = state?.roundTurnRolls.find((item) => item.playerId === playerId);
      if (turn?.choice !== 'build' && !(turn?.choice === 'choose' && selectedTurnMode === 'build')) return;
      const key = button.dataset.slot;
      const selectedAmount = selectedAllocations.get(key) ?? 0;
      if (selectedAmount === 0) return;
      if (selectedAmount === 1) selectedAllocations.delete(key);
      else selectedAllocations.set(key, selectedAmount - 1);
      render();
    } else if (action === 'tower-slot' && button.dataset.slot) {
      const key = button.dataset.slot;
      if (selectedTurnMode === 'bank') {
        if (selectedBankTowerIds.has(key)) selectedBankTowerIds.delete(key);
        else selectedBankTowerIds.add(key);
      } else {
        const state = currentState();
        const playerId = screen === 'host' ? hostId : guestId;
        const turn = state?.roundTurnRolls.find((item) => item.playerId === playerId);
        const player = state?.players.find((item) => item.id === playerId);
        const turnDie = turn?.die ?? 0;
        const spent = Array.from(selectedAllocations.values()).reduce((sum, value) => sum + value, 0);
        const selectedAmount = selectedAllocations.get(key) ?? 0;
        if (
          (turn?.choice !== 'build' && !(turn?.choice === 'choose' && selectedTurnMode === 'build')) ||
          !player ||
          spent >= turnDie
        ) return;
        if (key.startsWith('new-') && selectedAmount === 0) {
          const pendingCount = Array.from(selectedAllocations.keys()).filter((item) => item.startsWith('new-')).length;
          if (pendingCount > 0 || player.towers.length >= MAX_TOWERS) return;
        }
        selectedAllocations.set(key, selectedAmount + 1);
      }
      render();
    } else if (action === 'commit-move') {
      const playerId = screen === 'host' ? hostId : guestId;
      const state = currentState();
      const turn = state?.roundTurnRolls.find((item) => item.playerId === playerId);
      if (
        turn?.choice === 'build' ||
        (turn?.choice === 'choose' && selectedTurnMode === 'build')
      ) {
        const placements = Array.from(selectedAllocations, ([towerId, elements]) => ({
          towerId: towerId.startsWith('new-') ? null : towerId,
          elements,
          ...(towerId.startsWith('new-') ? { slot: Number(towerId.slice(4)) } : {}),
        }));
        commitAction(playerId, { kind: 'build', placements });
      } else if (selectedTurnMode === 'bank' && selectedBankTowerIds.size > 0) {
        commitAction(playerId, { kind: 'bank', towerIds: Array.from(selectedBankTowerIds) });
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
      clearPlayerRollReveal();
      animatedRollRound = 0;
      animatedRollPlayers.clear();
      submitted.clear();
      submittedCount = 0;
      selectedAllocations.clear();
      selectedBankTowerIds.clear();
      hostFormVisible = false;
      selectedTurnMode = null;
      rollPendingTurns();
      maybeResolveRound();
    } else if (action === 'rematch' && hostState) {
      hostState = beginRematch(hostState);
      clearPlayerRollReveal();
      animatedRollRound = 0;
      animatedRollPlayers.clear();
      submitted.clear();
      submittedCount = 0;
      selectedAllocations.clear();
      selectedBankTowerIds.clear();
      selectedTurnMode = null;
      rollPendingTurns();
      maybeResolveRound();
    } else if (action === 'return-lobby' && hostState) {
      if (autoRollTimer !== null) window.clearTimeout(autoRollTimer);
      autoRollTimer = null;
      hostState = returnToLobby(hostState);
      clearPlayerRollReveal();
      submitted.clear();
      submittedCount = 0;
      selectedAllocations.clear();
      selectedBankTowerIds.clear();
      selectedTurnMode = null;
      broadcastState();
      render();
    } else if (action === 'remove-player' && button.dataset.player) {
      removePlayer(button.dataset.player);
    } else if (action === 'cancel-guest') {
      const peer = guestPeer;
      guestPeer = null;
      guestChannel = null;
      guestConnecting = false;
      guestState = null;
      guestSubmitted = false;
      clearPlayerRollReveal();
      selectedAllocations.clear();
      selectedBankTowerIds.clear();
      selectedTurnMode = null;
      animatedRollRound = 0;
      animatedRollPlayers.clear();
      screen = 'home';
      notice = '';
      guestRoomCode = '';
      guestResumeToken = '';
      guestRecoveryAvailable = null;
      peer?.destroy();
      try {
        window.localStorage.removeItem(GUEST_RECOVERY_KEY);
      } catch (error) {
        throw new Error(`Could not clear saved guest recovery data. ${error instanceof Error ? error.message : ''}`.trim());
      }
      render();
    } else if (action === 'rules') {
      window.alert(
        `${localizeText('Roll one die, then choose Build or Bank. Build spends up to the roll in floors. Bank scores up to the roll in towers; you may bank fewer. Banked towers are protected from the wind.', language)}\n\n${localizeText('Round order: resolve everyone’s submitted builds and banks, then award bank points. If anyone reaches the target, the game ends before the wind check. Otherwise, calculate protection from towers still standing (banked towers are removed and do not protect the skyline), then check all remaining towers together. Each standing tower beyond the first adds +1 to every tower’s base limit, up to +3. A tower topples when the two-die wind total is equal to or greater than its base limit plus protection. Base limit by height: 1 = 12, 2 = 11, 3 = 10, 4 = 9, 5 = 8, 6 = 7, 7 = 6, 8 = 5, 9 = 4, 10 = 3, 11+ = 2.', language)}`,
      );
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
      hostResumeTokens.clear();
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

hostRecoveryAvailable = loadRecoveryRecord(HOST_RECOVERY_KEY, parseHostRecovery);
guestRecoveryAvailable = loadRecoveryRecord(GUEST_RECOVERY_KEY, parseGuestRecovery);
try {
  const savedLanguage = window.localStorage.getItem(LANGUAGE_PREFERENCE_KEY);
  if (isLanguage(savedLanguage)) language = savedLanguage;
} catch {
  failure = 'Could not read the saved language preference in this browser.';
}
window.addEventListener('pagehide', persistRecovery);
render();
registerServiceWorker();
