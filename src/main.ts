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
import {
  createPeerConnection,
  decodeSignal,
  encodeSignal,
  renderQr,
  scanQr,
  waitForIceGathering,
} from './signaling';
import './style.css';

interface HostConnection {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  playerId: string | null;
}

type Screen = 'home' | 'host' | 'guest-setup' | 'guest';
type ScanMode = 'host-answer' | 'guest-offer';

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
let pairing: { connection: HostConnection; offer: string; accepted: boolean } | null = null;
let creatingOffer = false;
let roomGeneration = 0;
let guestPeer: RTCPeerConnection | null = null;
let guestChannel: RTCDataChannel | null = null;
let scanMode: ScanMode | null = null;
let scanAbort: AbortController | null = null;
let notice = '';
let failure = '';

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
  if (pairing && screen === 'host' && !pairing.accepted) void attachQr('#offer-qr', pairing.offer);
  if (screen === 'guest' && guestAnswer) void attachQr('#answer-qr', guestAnswer);
}

let guestAnswer = '';

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
    <div><strong>Playing on phones?</strong><p>Open this page on every device. Pair guests with a two-way QR scan over the same Wi‑Fi. Keep the host tab open and in the foreground.</p></div>
  </section>
  <div id="host-form-slot"></div>
`;
}

function renderGuestSetup(): string {
  return `<section class="narrow-panel">
    <button class="back-link" data-action="home" type="button">← Back</button>
    <p class="eyebrow">JOIN THE SKYLINE</p>
    <h1>Scan the host's<br /><em>offer code.</em></h1>
    <p class="lead-small">Use the camera in this page to scan the offer QR shown on the host's screen. Then show your answer QR for the host to scan.</p>
    <form id="guest-form" class="form-card">
      <label for="guest-name">Your name</label>
      <input id="guest-name" name="name" maxlength="18" autocomplete="nickname" required value="${escapeHtml(guestName)}" placeholder="e.g. Robin" />
      <button class="button button-primary button-full" type="submit">Scan host offer</button>
    </form>
    ${renderScanner()}
    ${guestAnswer ? `<section class="pair-card">
      <p class="eyebrow">SHOW THIS TO THE HOST</p><h2>Your answer code</h2>
      <img id="answer-qr" class="qr-image" alt="QR code with your WebRTC answer for the host" />
      <p class="quiet-note">Keep this page open while the host scans. Connection details stay between these browsers.</p>
      <button class="button button-secondary button-full" data-action="cancel-guest" type="button">Cancel</button>
    </section>` : ''}
  </section>`;
}

function renderHost(): string {
  if (!hostState) return '';
  const state = hostState;
  if (state.status !== 'lobby') return renderGame(state, true);
  return `<section class="game-panel">
    <div class="section-heading"><div><p class="eyebrow">HOST LOBBY</p><h1>Your skyline <em>starts here.</em></h1></div><span class="pill">${connectedPlayers(state).length}/${MAX_PLAYERS} players</span></div>
    <p class="lead-small">You are the host and a player. Add each guest by exchanging two QR codes. Both phones must be on the same Wi‑Fi.</p>
    <div class="player-list">${state.players.map((player) => playerMarkup(player, true)).join('')}</div>
    <div class="pair-area">
      ${creatingOffer ? `<p class="quiet-note">Preparing a private connection code…</p>` : pairing && !pairing.accepted ? `<div class="pair-card">
        <p class="eyebrow">STEP 1 · GUEST SCANS THIS</p><h2>Host offer code</h2>
        <img id="offer-qr" class="qr-image" alt="WebRTC offer QR code for a guest to scan" />
        <p class="quiet-note">On the guest's phone, open this same site, enter a name, and scan this code.</p>
        <div class="button-row"><button class="button button-secondary" data-action="scan-answer" type="button">Scan guest answer</button><button class="text-button" data-action="cancel-pair" type="button">Cancel pairing</button></div>
      </div>` : pairing?.accepted ? `<div class="pair-card">
        <p class="eyebrow">STEP 2 · CONNECTING</p><h2>Waiting for guest</h2>
        <p class="quiet-note">Their browser is opening the direct connection. Keep both pages open.</p>
        <button class="text-button" data-action="cancel-pair" type="button">Cancel pairing</button>
      </div>` : `<button class="button button-secondary" data-action="add-guest" type="button" ${connectedPlayers(state).length >= MAX_PLAYERS || creatingOffer ? 'disabled' : ''}>＋ Add a guest</button>`}
      ${renderScanner()}
      ${connectedPlayers(state).length >= MIN_PLAYERS ? `<button class="button button-primary button-full start-button" data-action="start-game" type="button" ${pairing || creatingOffer ? 'disabled' : ''}>Start game <span aria-hidden="true">→</span></button>` : `<p class="quiet-note">Waiting for at least one guest. The host counts as a player.</p>`}
    </div>
    <details class="help-details"><summary>Connection notes</summary><p>GitHub Pages needs internet to load the game. Pairing uses direct browser-to-browser WebRTC and does not use a relay. If local network access or camera permission is blocked, pairing may fail. iPhone may suspend a background tab; keep the host page open in front.</p></details>
  </section>`;
}

function renderGuest(): string {
  if (!guestState) {
    return `<section class="narrow-panel">
      <p class="eyebrow">GUEST CONNECTION</p><h1>Waiting for the<br /><em>host.</em></h1>
      ${guestAnswer ? `<div class="pair-card"><img id="answer-qr" class="qr-image" alt="Your WebRTC answer QR code" /><p class="quiet-note">The host must scan this answer code. Keep this page open.</p></div>` : ''}
      <p class="lead-small">When the direct connection is ready, the shared lobby will appear here.</p>
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

function renderScanner(): string {
  return scanMode ? `<div class="scanner-card"><video id="scanner" playsinline muted aria-label="Camera scanning a QR code"></video>
    <p class="quiet-note">Point the camera at the other phone's Skyline QR code.</p>
    <button class="text-button" data-action="stop-scan" type="button">Cancel scan</button></div>` : '';
}

async function attachQr(selector: string, value: string): Promise<void> {
  try {
    const url = await renderQr(value);
    const image = app?.querySelector<HTMLImageElement>(selector);
    if (image) image.src = url;
  } catch (error) {
    showFailure(error instanceof Error ? `Could not create QR code: ${error.message}` : 'Could not create QR code.');
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
    if (pairing?.connection === connection) pairing = null;
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
  connection.channel.onmessage = (event: MessageEvent<string>) => {
    try {
      messageForConnection(connection, parseMessage(event.data));
    } catch (error) {
      connection.channel.send(JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Invalid game message.',
      }));
    }
  };
  connection.channel.onopen = () => {
    notice = 'Connection ready. The guest can join the lobby now.';
    render();
  };
  connection.channel.onclose = () => {
    const playerId = connection.playerId;
    if (!playerId || !hostState) return;
    const player = hostState.players.find((item) => item.id === playerId);
    if (player) player.connected = false;
    notice = `${player?.name ?? 'A guest'} disconnected. Remove them to continue.`;
    broadcastState();
    render();
  };
  connection.peer.onconnectionstatechange = () => {
    if (connection.peer.connectionState === 'failed' || connection.peer.connectionState === 'closed') {
      connection.channel.close();
    }
  };
}

function broadcastState(): void {
  if (!hostState) return;
  submittedCount = submitted.size;
  for (const connection of hostConnections) {
    if (connection.playerId && connection.channel.readyState === 'open') {
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

async function createHostOffer(): Promise<void> {
  if (!hostState || hostState.players.length >= MAX_PLAYERS || pairing || creatingOffer) return;
  creatingOffer = true;
  const generation = roomGeneration;
  render();
  const peer = createPeerConnection();
  const channel = peer.createDataChannel('skyline-game');
  const connection: HostConnection = { peer, channel, playerId: null };
  hostConnections.add(connection);
  attachHostConnection(connection);
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error('The browser did not create a connection offer.');
    if (generation !== roomGeneration) {
      hostConnections.delete(connection);
      peer.close();
      return;
    }
    pairing = { connection, offer: encodeSignal({ type: 'offer', sdp }), accepted: false };
    notice = '';
    failure = '';
  } catch (error) {
    hostConnections.delete(connection);
    peer.close();
    if (generation === roomGeneration) {
      failure = error instanceof Error ? error.message : 'Could not prepare a guest connection.';
      notice = '';
    }
  } finally {
    if (generation === roomGeneration) {
      creatingOffer = false;
      render();
    }
  }
}

async function acceptHostAnswer(value: string): Promise<void> {
  if (!pairing) throw new Error('There is no guest pairing waiting for an answer.');
  const signal = decodeSignal(value);
  if (signal.type !== 'answer') throw new Error('Scan the guest answer code, not another host offer.');
  await pairing.connection.peer.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
  pairing.accepted = true;
  notice = 'Answer received. Waiting for the guest connection.';
  render();
}

async function acceptGuestOffer(value: string): Promise<void> {
  const signal = decodeSignal(value);
  if (signal.type !== 'offer') throw new Error('Scan the host offer code, not another guest answer.');
  const peer = createPeerConnection();
  guestPeer = peer;
  peer.ondatachannel = (event) => {
    guestChannel = event.channel;
    guestChannel.onopen = () => {
      guestChannel?.send(JSON.stringify({ type: 'join', playerId: guestId, name: guestName }));
      notice = 'Connected to the host. Joining the lobby…';
      render();
    };
    guestChannel.onmessage = (messageEvent: MessageEvent<string>) => {
      try {
        const message = parseMessage(messageEvent.data);
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
    };
    guestChannel.onclose = () => {
      showFailure('The host connection closed. The match cannot be recovered if the host page was closed.');
    };
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      showFailure('The direct connection was interrupted. Ask the host to pair you again.');
    }
  };
  await peer.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGathering(peer);
  const sdp = peer.localDescription?.sdp;
  if (!sdp) throw new Error('The browser did not create a connection answer.');
  guestAnswer = encodeSignal({ type: 'answer', sdp });
  screen = 'guest';
  notice = 'Show your answer code to the host, then wait for the lobby.';
  render();
}

async function startScan(mode: ScanMode): Promise<void> {
  scanMode = mode;
  scanAbort = new AbortController();
  render();
  const video = app?.querySelector<HTMLVideoElement>('#scanner');
  if (!video) {
    scanMode = null;
    showFailure('Could not open the camera view.');
    return;
  }
  try {
    const value = await scanQr(video, scanAbort.signal);
    scanAbort = null;
    scanMode = null;
    render();
    if (mode === 'host-answer') await acceptHostAnswer(value);
    else await acceptGuestOffer(value);
  } catch (error) {
    scanAbort = null;
    scanMode = null;
    if (error instanceof DOMException && error.name === 'AbortError') {
      notice = '';
      render();
      return;
    }
    if (mode === 'guest-offer') {
      guestPeer?.close();
      guestPeer = null;
      guestChannel = null;
      guestAnswer = '';
    }
    showFailure(error instanceof Error ? error.message : 'Could not scan that QR code.');
  }
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
      connection.peer.close();
    }
  }
  notice = `${player.name} was removed from the room.`;
  broadcastState();
  if (hostState.status === 'choice') maybeResolveRound();
  else render();
}

function resetRoom(): void {
  roomGeneration += 1;
  creatingOffer = false;
  for (const connection of hostConnections) connection.peer.close();
  hostConnections.clear();
  guestPeer?.close();
  hostState = null;
  guestState = null;
  pairing = null;
  submitted.clear();
  screen = 'home';
  notice = '';
  failure = '';
  guestAnswer = '';
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
      guestAnswer = '';
      render();
    } else if (action === 'add-guest') {
      await createHostOffer();
    } else if (action === 'scan-answer') {
      await startScan('host-answer');
    } else if (action === 'cancel-pair') {
      if (pairing) {
        hostConnections.delete(pairing.connection);
        pairing.connection.peer.close();
        pairing = null;
      }
      scanMode = null;
      notice = 'Guest pairing cancelled.';
      render();
    } else if (action === 'stop-scan') {
      scanAbort?.abort();
      scanAbort = null;
      scanMode = null;
      render();
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
      guestPeer?.close();
      guestPeer = null;
      guestChannel = null;
      guestState = null;
      guestSubmitted = false;
      guestAnswer = '';
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
    } else if (form.id === 'guest-form') {
      const data = new FormData(form);
      guestName = String(data.get('name') ?? '').trim();
      if (!guestName || guestName.length > 18) throw new Error('Enter a name with 1–18 characters.');
      guestId = randomId();
      await startScan('guest-offer');
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
