import {
  beginGame,
  beginNextRound,
  createMatch,
  heightLimit,
  isLegalAction,
  MAX_PLAYERS,
  MIN_PLAYERS,
  resolveRound,
  towerPoints,
  type MatchState,
  type Player,
  type PlayerAction,
} from './game';
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
let hostConnections = new Set<HostConnection>();
let hostPeer: Peer | null = null;
let hostRoomCode = '';
let creatingRoomCode = false;
let roomGeneration = 0;
let guestPeer: Peer | null = null;
let guestChannel: DataConnection | null = null;
let notice = '';
let failure = '';

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

function currentState(): MatchState | null {
  return screen === 'host' ? hostState : guestState;
}

function connectedPlayers(state: MatchState): Player[] {
  return state.players.filter((player) => player.connected);
}

function showNotice(message: string): void {
  notice = message;
  failure = '';
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
    <span>One shared wind. Your call.</span>
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
    <article><span class="feature-icon">↗</span><div><strong>Build together</strong><p>One move every round. Every player in.</p></div></article>
    <article><span class="feature-icon">◉</span><div><strong>Read the wind</strong><p>The taller the tower, the riskier the climb.</p></div></article>
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
    <div class="section-heading"><div><p class="eyebrow">HOST LOBBY</p><h1>Your skyline <em>starts here.</em></h1></div><span class="pill">${connectedPlayers(state).length}/${MAX_PLAYERS} players</span></div>
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
    <div class="player-list">${state.players.map((player) => playerMarkup(player, true)).join('')}</div>
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
      <div class="section-heading"><div><p class="eyebrow">CONNECTED TO HOST</p><h1>Waiting for<br /><em>liftoff.</em></h1></div><span class="pill">${connectedPlayers(guestState).length}/${MAX_PLAYERS} players</span></div>
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
    <span class="player-name">${escapeHtml(player.name)}${me ? ' <span class="you-tag">YOU</span>' : ''}${player.id === hostPlayerId ? ' <span class="host-tag">HOST</span>' : ''}</span>
    <span class="player-meta">${player.connected ? 'Connected' : 'Disconnected'}</span>
    ${hostControls && player.id !== hostId && !player.connected ? `<button class="text-button danger-text" data-action="remove-player" data-player="${escapeHtml(player.id)}" type="button">Remove</button>` : ''}
  </article>`;
}

function renderGame(state: MatchState, isHost: boolean): string {
  const playerId = isHost ? hostId : guestId;
  const me = state.players.find((player) => player.id === playerId);
  const isSubmitted = isHost ? submitted.has(hostId) : guestSubmitted;
  const choices = state.status === 'choice' && me && !isSubmitted
    ? actionForm(me)
    : state.status === 'choice'
      ? `<div class="wait-card"><span class="spinner" aria-hidden="true"></span><div><strong>${isSubmitted ? 'Choice locked in' : 'Choose your move'}</strong><p>${isSubmitted ? `Waiting for other players · ${submittedCount}/${state.players.length} committed` : `Waiting for your choice · ${submittedCount}/${state.players.length} committed`}</p></div></div>`
      : '';

  return `<section class="game-panel board-panel">
    <div class="section-heading"><div><p class="eyebrow">${state.status === 'finished' ? 'GAME OVER' : `ROUND ${state.round}`}</p><h1>${state.status === 'finished' ? 'The skyline is <em>set.</em>' : 'Build or <em>bank?</em>'}</h1></div>
      ${state.status === 'choice' && state.dice ? `<div class="wind-card"><span>WIND</span><div class="dice-pair"><b>${state.dice[0]}</b><b>${state.dice[1]}</b></div><strong>${state.dice[0] + state.dice[1]}</strong></div>` : ''}
    </div>
    ${state.status === 'choice' ? `<p class="lead-small">The wind is known. Pick one move before it sweeps through every unbanked tower.</p>` : ''}
    <section class="scoreboard" aria-label="Players and scores">
      ${state.players.map((player) => `<article class="score-card ${player.id === playerId ? 'score-card-me' : ''}">
        <div class="score-card-top"><span class="player-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><span class="score-name">${escapeHtml(player.name)}${player.id === playerId ? ' <span class="you-tag">YOU</span>' : ''}${player.connected ? '' : ' <span class="host-tag">OFFLINE</span>'}</span></div>
        <div class="score-number">${player.score}<small> pts</small></div>
        <div class="banked-label">${player.bankedTowers}/3 towers banked</div>
        <div class="tower-list">${player.towers.length ? player.towers.map((tower) => {
          const limit = heightLimit(tower.height);
          const atRisk = state.dice && state.status === 'choice' && state.dice[0] + state.dice[1] >= limit;
          return `<div class="tower-chip ${atRisk ? 'tower-risk' : ''}"><span class="tower-icon" aria-hidden="true">▥</span><span>Height ${tower.height}</span><span class="tower-limit">topples at ${limit}+</span></div>`;
        }).join('') : '<span class="empty-towers">No unbanked towers</span>'}</div>
        ${isHost && player.id !== hostId && !player.connected ? `<button class="text-button danger-text" data-action="remove-player" data-player="${escapeHtml(player.id)}" type="button">Remove disconnected player</button>` : ''}
      </article>`).join('')}
    </section>
    ${choices}
    ${state.status === 'resolution' ? `<section class="resolution-card"><p class="eyebrow">ROUND ${state.history.at(-1)?.round ?? state.round} COMPLETE</p><h2>The wind has passed.</h2><p>${state.history.at(-1)?.toppled.length ? `${state.history.at(-1)!.toppled.length} tower${state.history.at(-1)!.toppled.length === 1 ? '' : 's'} toppled.` : 'Every tower held.'}</p>
      ${isHost ? `<button class="button button-primary button-full" data-action="next-round" type="button">Roll next round <span aria-hidden="true">→</span></button>` : '<p class="quiet-note">The host will roll the next wind.</p>'}</section>` : ''}
    ${state.status === 'finished' ? `<section class="resolution-card winner-card"><p class="eyebrow">FINAL STANDINGS</p><h2>${state.winnerIds.length > 1 ? 'A shared victory.' : `${escapeHtml(state.players.find((player) => player.id === state.winnerIds[0])?.name ?? 'A player')} wins!`}</h2><p>${state.winnerIds.length > 1 ? 'The tallest scores are tied.' : 'The skyline belongs to you.'}</p>${isHost ? '<button class="button button-primary button-full" data-action="new-game" type="button">Host another game</button>' : '<p class="quiet-note">The host can start another room.</p>'}</section>` : ''}
    <section class="history-card"><div class="history-heading"><p class="eyebrow">THE BUILD LOG</p><span>${state.history.length} round${state.history.length === 1 ? '' : 's'}</span></div>
      ${state.history.length ? `<ol class="history-list">${[...state.history].reverse().map((round) => historyMarkup(round, state)).join('')}</ol>` : '<p class="quiet-note">Every roll, move, and toppled tower will appear here.</p>'}
    </section>
    ${state.status !== 'finished' ? `<details class="help-details"><summary>Rules &amp; wind limits</summary>${rulesMarkup()}</details>` : ''}
  </section>`;
}

function actionForm(player: Player): string {
  const options = [
    '<option value="new">Start a new tower · height 1</option>',
    ...player.towers.flatMap((tower) => [
      `<option value="build|${escapeHtml(tower.id)}">Build tower ${tower.height} → height ${tower.height + 1}</option>`,
      `<option value="bank|${escapeHtml(tower.id)}">Bank tower ${tower.height} · +${towerPoints(tower.height)} points</option>`,
    ]),
  ];
  return `<form id="action-form" class="action-card">
    <label for="player-action">Your move</label>
    <select id="player-action" name="action">${options.join('')}</select>
    <button class="button button-primary button-full" type="submit">Commit move</button>
    <p class="quiet-note">Your move stays hidden until every player commits.</p>
  </form>`;
}

function historyMarkup(round: MatchState['history'][number], state: MatchState): string {
  const name = (id: string) => state.players.find((player) => player.id === id)?.name ?? 'A player';
  const actionText = round.actions.map((action) => `${name(action.playerId)} ${action.description.toLowerCase()}`).join(' · ');
  const bankedText = round.banked.map((banked) => `${name(banked.playerId)} banked +${banked.points}`).join(' · ');
  const toppledText = round.toppled.map((tower) => `${name(tower.playerId)}'s height-${tower.height} tower toppled`).join(' · ');
  return `<li><div class="history-round"><b>R${round.round}</b><span class="history-dice">${round.dice[0]} + ${round.dice[1]} = ${round.wind}</span></div>
    <p>${escapeHtml(actionText || 'No moves')}</p>${bankedText ? `<p class="history-good">${escapeHtml(bankedText)}</p>` : ''}
    ${toppledText ? `<p class="history-bad">${escapeHtml(toppledText)}</p>` : '<p class="history-good">The towers held.</p>'}</li>`;
}

function rulesMarkup(): string {
  return `<p>Each round, the shared wind is two dice added together. After seeing it, everyone simultaneously starts a tower, adds one floor, or banks one tower. Banking scores 1 + 2 + … + height and protects that tower. All other towers face the wind after the move. The game ends after a round in which someone banks a third tower; highest score wins, ties share the win.</p>
    <div class="limit-table"><span>Height</span><span>Topples at wind</span>${[1, 2, 3, 4, 5, 6, 7].map((height) => `<b>${height === 7 ? '7+' : height}</b><b>${heightLimit(height)}+</b>`).join('')}</div>
    <p class="quiet-note">The roll is revealed before choices. A new or extended tower is exposed to that same wind.</p>`;
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
      towers: [],
      connected: true,
    });
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
      connection.channel.send(JSON.stringify({ type: 'error', message: 'That move cannot be accepted now.' }));
      return;
    }
    const player = hostState.players.find((item) => item.id === message.playerId);
    if (!player || !isLegalAction(player, message.action)) {
      connection.channel.send(JSON.stringify({ type: 'error', message: 'That move is not legal for your towers.' }));
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
        state: hostState,
        submittedCount,
        playerId: connection.playerId,
      }));
    }
  }
}

function maybeResolveRound(): void {
  if (!hostState || hostState.status !== 'choice' || submitted.size !== hostState.players.length) {
    broadcastState();
    render();
    return;
  }
  try {
    hostState = resolveRound(hostState, submitted);
    submitted.clear();
    submittedCount = 0;
    broadcastState();
    render();
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'Could not resolve this round.');
  }
}

function commitAction(playerId: string, action: PlayerAction): void {
  const state = currentState();
  if (!state || state.status !== 'choice' || (screen === 'host' && submitted.has(playerId)) || guestSubmitted) return;
  const player = state.players.find((item) => item.id === playerId);
  if (!player || !isLegalAction(player, action)) {
    showFailure('That move is no longer available. Choose another move.');
    return;
  }
  submitted.set(playerId, action);
  if (screen === 'host') {
    submittedCount = submitted.size;
    maybeResolveRound();
  } else {
    guestChannel?.send(JSON.stringify({ type: 'action', playerId, action }));
    guestSubmitted = true;
    showNotice('Move committed. Waiting for the other players.');
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
          guestState = message.state;
          submittedCount = message.submittedCount;
          if (guestState.status !== 'choice' || guestState.round !== previousRound) guestSubmitted = false;
          failure = '';
          notice = '';
          screen = 'guest';
          render();
        } else if (message.type === 'error') {
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
  hostState.players = hostState.players.filter((item) => item.id !== playerId);
  submitted.delete(playerId);
  for (const connection of hostConnections) {
    if (connection.playerId === playerId) {
      hostConnections.delete(connection);
      connection.channel.close();
    }
  }
  notice = `${player.name} was removed from the room.`;
  broadcastState();
  if (hostState.status === 'choice') maybeResolveRound();
  else render();
}

function resetRoom(): void {
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
  screen = 'home';
  notice = '';
  failure = '';
  render();
}

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
    } else if (action === 'start-game' && hostState) {
      if (connectedPlayers(hostState).length < MIN_PLAYERS) {
        showFailure('At least two connected players are needed.');
        return;
      }
      if (connectedPlayers(hostState).length !== hostState.players.length) {
        showFailure('Remove disconnected players before starting the game.');
        return;
      }
      hostState = beginGame(hostState, rollDice());
      submitted.clear();
      submittedCount = 0;
      broadcastState();
      render();
    } else if (action === 'next-round' && hostState) {
      hostState = beginNextRound(hostState, rollDice());
      submitted.clear();
      submittedCount = 0;
      broadcastState();
      render();
    } else if (action === 'remove-player' && button.dataset.player) {
      removePlayer(button.dataset.player);
    } else if (action === 'new-game') {
      resetRoom();
    } else if (action === 'cancel-guest') {
      guestPeer?.destroy();
      guestPeer = null;
      guestChannel = null;
      guestState = null;
      guestSubmitted = false;
      screen = 'home';
      notice = '';
      render();
    } else if (action === 'rules') {
      window.alert('Each round, everyone starts a tower, adds a floor, or banks one. The shared 2d6 wind is revealed first. After all players commit, banking scores 1 + 2 + … + height and protects that tower; every other tower topples when the wind reaches its height limit. The game ends after someone banks a third tower. Highest score wins.');
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
    } else if (form.id === 'action-form') {
      const select = form.querySelector<HTMLSelectElement>('[name="action"]');
      if (!select) throw new Error('Choose a move first.');
      const [kind, towerId] = select.value.split('|');
      const action: PlayerAction = kind === 'new'
        ? { kind: 'new' }
        : kind === 'build'
          ? { kind: 'build', towerId: towerId ?? '' }
          : { kind: 'bank', towerId: towerId ?? '' };
      commitAction(screen === 'host' ? hostId : guestId, action);
    }
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'The form could not be submitted.');
  }
});

render();
