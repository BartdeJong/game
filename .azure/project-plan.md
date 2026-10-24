# Skyline Dice — Project Plan

**Status**: Approved
**Created**: 2026-10-24
**Mode**: Standard

## 1. Project Overview

Build Skyline Dice as a minimal, mobile-friendly TypeScript browser game for 2–5 players, including iPhone browsers, with nothing to install. The static app is published free on GitHub Pages. For a live match, the host's browser is authoritative and connects directly to each guest browser using a separate WebRTC data channel. Guests join by entering one short room code. The host is also a player.

No accounts, application-owned database, persistent preferences, or match history are in scope. PeerJS Cloud provides temporary signaling only; active match state exists only in the host browser's memory.

## 2. Goals and Scope

- Implement the approved MVP rules and defaults in section 4.
- Let a host create a 2–5 player room and play alongside guests, with no extra app or software installed.
- Let the host add and remove automatic robot players in the lobby, enabling solo play and filling open seats.
- Let the host set a points-to-win target before each game, automatically roll the next round after a short results pause, and retain room win totals across rematches.
- Provide an easy lobby, shared round roll, simultaneous choices, resolution feedback, score display, and final result.
- Publish the static frontend through free GitHub Pages hosting and let guests join with a single short room code through PeerJS Cloud signaling.
- Keep the UI and interactions usable on phones, tablets, and desktop browsers.

Out of scope: accounts, an application-owned signaling backend, online matchmaking, saved games, chat, spectator mode, automatic LAN discovery, and host migration.

## 3. Architecture and Game Flow

**Static frontend**: TypeScript with plain HTML/CSS and Pico.css, built as static assets and published on GitHub Pages over HTTPS. There is no Node.js server, backend, or hosted room service. The host and guests open the same static app in their browsers. GitHub Pages requires internet for the initial page load unless the browser already has a usable cached copy.

**Host-authoritative peer architecture**: The host browser owns all active room state, generates the shared dice result, validates player actions, resolves rounds, scores, and distributes authoritative updates. PeerJS Cloud introduces guests to the host using an eight-character room code. PeerJS creates a separate WebRTC data channel for each guest. Guest browsers send actions only to the host; guests do not connect to one another. The host is included as a player and applies the same game rules locally. The app uses the public PeerJS signaling service and STUN, but does not configure a TURN relay. No Azure resources or application-owned backend are planned.

**Room-code join flow**:
1. Host and guests open the GitHub Pages app in their browsers. The host creates a room and enters a display name.
2. The host reserves an eight-character PeerJS ID and shares it as the room code. If the ID is already in use, the app generates another.
3. Each guest enters the code and their name. PeerJS Cloud brokers the WebRTC setup; gameplay then uses a direct data channel where the network permits. Repeat by sharing the same code with each guest.
4. Once 2–5 human and robot players, including the host, are present, the host can start. Human players commit one private choice per round; robot choices are submitted automatically. The host reveals choices together only after all players have submitted, then sends each guest a personalized state that hides opponents' towers and detailed actions.

The room code is an invite and should only be shared with intended players. The PeerJS Cloud service handles peer discovery and signaling but does not receive game messages after direct connection setup. No camera permission or manual offer/answer exchange is required. The free shared service may be rate-limited or unavailable; it is not guaranteed for production. The app configures STUN but no TURN relay, so restrictive NAT/firewall networks can still prevent peers from connecting.

**Round flow**: collect simultaneous hidden human choices and automatic robot choices → roll and share the round's 2d6 wind result → apply valid build/bank actions → topple exposed towers according to the wind table → publish scores and per-player fall counts without revealing opponents' towers or detailed actions → automatically begin the next round after a 3-second results pause unless a player has reached the room's points target.

**Connectivity and lifecycle constraints**: Room setup requires internet access to reach PeerJS Cloud. WebRTC direct connectivity depends on the iOS browser, Wi-Fi/network policy, and ICE behavior; same-Wi-Fi access alone does not guarantee peer connectivity (for example, client isolation or browser restrictions can prevent it). This must be verified on real iPhones before implementation is considered viable. The shared PeerJS service's uptime, rate limits, and room-ID availability are outside the app's control. A disconnected guest's seat/state remains only in host memory and the round may pause while the host removes them; exact recovery behavior is a validation item. There is no host migration. If the host closes the page, the host browser is backgrounded or suspended, or the device/browser loses the active page, the match may be interrupted or lost. Active state is not persisted or recoverable from another device.

**Product constraints to communicate in the UI/help**: GitHub Pages needs internet for initial load unless cached; internet is required for PeerJS signaling; guests enter a shared short room code; the public signaling service may be unavailable; direct peer connectivity can fail on restrictive networks; Safari backgrounding/closing can interrupt the host. No TURN relay is configured.

## 4. Game Rules and Approved Defaults

**Approved baseline**:
- Each round has one shared roll of two standard six-sided dice.
- Each player simultaneously performs one action: add one floor to an existing unbanked tower, start a new one-floor tower, or bank one existing tower.
- After the action and shared wind roll, every unbanked tower that meets its height-specific toppling limit is lost.
- Banking scores triangular points for that tower's height.
- The first player to reach or exceed the host-configured points target wins after the round resolves.

**Approved MVP defaults**:

| Mechanic | Approved playable default |
|---|---|
| Wind strength | Sum of the two dice, from 2–12. |
| Toppling test | An unbanked tower topples when wind strength is greater than or equal to its height's limit. |
| Height → wind limit | Height 1: 12; 2: 11; 3: 10; 4: 9; 5: 8; 6: 7; 7 or higher: 6. |
| Roll/choice timing | Players privately commit simultaneously before the shared roll; the host rolls and shares it after all choices are locked. |
| Build exposure | Apply the chosen build before the toppling test; a newly started or extended tower is exposed to that round's wind. |
| Banking | A bank action secures one existing tower before wind resolution and scores `height × (height + 1) / 2`; no other action is taken by that player that round. |
| Final round | End after resolving the round in which any player reaches or exceeds the host-configured target. |
| Winner/ties | Highest score wins; equal high scores share the victory, with each tied winner receiving one room win. |
| Room start | Host can start with 2–5 players, including robots; all human players must be connected. |
| Win target | Host sets 10–200 points before a game; default is 80. |
| Automatic next roll | Start the next round automatically 3 seconds after showing the result. |
| Room win tally | Increment each winner's room win count; tied winners each receive one win. Preserve totals through rematches in the same room. |

These approved limits and timing choices materially affect risk and strategy; surface them in the game rules/help panel.

## 5. State, Validation, and Deliverables

**Ephemeral room state**: room status and round number; connected player IDs/names; each player's unbanked tower heights, banked tower count, and score; shared dice result; pending choices; and final result. Store active state only in the host browser's memory. Do not create user accounts, durable identifiers, or match history.

**Host validation**: enforce room capacity and game phase; accept one valid action per connected player per round; ensure tower references exist and banking/build choices are legal; prevent duplicate submissions and guest-side score/dice edits; and resolve each round exactly once before broadcasting authoritative state.

**Deliverables**:
- TypeScript responsive static game frontend, short room-code join flow, and accessible rules/help content.
- Host-authoritative WebRTC data-channel protocol with one direct connection per guest and PeerJS Cloud for signaling.
- GitHub Pages build/deployment workflow for the static frontend.
- User instructions for initial load, room-code sharing, signaling/network limitations, and restarting a lost room.
- Unit tests for rules/state transitions and a real-device iPhone Safari smoke-test checklist.

## 6. Design System & UI

**Component Library**: Pico.css
**Visual direction**: clean skyline/architecture motif, high-contrast dice and tower state, restrained color, and clear risk feedback. Use semantic HTML and native form controls styled consistently rather than introducing a heavier component framework.

**Screens and key interactions**:
- **Host / Join**: room creation and host name entry; a readable eight-character invite code and copy action; guest name and room-code form; connection status. Explain that room codes should be shared privately, signaling requires internet, and direct connectivity can fail on restrictive networks.
- **Lobby**: player list, host indicator, capacity status, connection status, and host-only start control enabled at 2–5 players.
- **Game board**: player score/banked count, distinct tower cards with height and current wind limit, shared dice result, round status, and action controls for build, new tower, or bank. Choices remain private until all active players submit; show a waiting state and allow a player to revise only before submission.
- **Resolution**: reveal simultaneous choices, tower collapses/banking, points gained, and updated scores; explain why each tower toppled.
- **Results**: winner or shared tie, final scores, and host option to start a fresh room (no history retained).

Use responsive layouts and keyboard-accessible controls, labels, focus states, and status announcements. Do not rely on color alone to distinguish safe, at-risk, banked, or toppled towers.

## 7. Implementation Plan

1. Validate feasibility first on real iPhones: confirm PeerJS Cloud availability, Safari WebRTC data-channel connectivity, room-code entry, and direct ICE connectivity on the intended same-Wi-Fi setup. Treat failure as a blocker requiring a revised connection design; do not assume viability from desktop emulation.
2. Define typed game-state/action models and pure rule-resolution functions using the approved defaults.
3. Build the static responsive app and PeerJS Cloud room-code flow; establish and manage a separate host-to-guest WebRTC data channel for every guest, without a TURN relay.
4. Implement host-authoritative in-memory room lifecycle, action validation, round resolution, and broadcast of state over the data channels.
5. Build the responsive lobby, game board, simultaneous action flow, resolution, and results screens; provide clear connection/backgrounding guidance.
6. Configure and verify the static GitHub Pages build and publishing workflow.
7. Add rules/limitations documentation and complete real-device smoke tests for an iPhone Safari host and iPhone Safari guests.

## 8. Acceptance Criteria and Tests

- A room supports 2–5 players, including the host; a sixth player is rejected with a clear message.
- A host can share one short room code that each guest enters to connect, without manual offer/answer exchange.
- An iPhone Safari host and iPhone Safari guest can establish a direct same-Wi-Fi WebRTC data channel on real devices; this is a go/no-go feasibility criterion.
- All clients show the same host-generated 2d6 result and resolved state.
- Choices remain hidden until all connected active players submit; duplicate, invalid, or late actions do not alter state.
- Tests cover each height threshold boundary, newly built tower exposure, banking before wind, triangular scoring, tower loss, configurable target endings, tied room wins, and rematch persistence.
- Final winner/tie and scores match across host and guests; host memory is the sole active state and no host migration or durable recovery is supported.
- The real-device smoke test covers iPhone Safari in both host and guest roles, PeerJS signaling, same-Wi-Fi peer connectivity, multiple guests joining with the same code, background/resume interruption, guest disconnect, and clear failure messaging.
- The frontend builds and publishes as a static GitHub Pages site; documentation states that initial loading and signaling need internet unless the page is cached, and identifies the shared signaling service as an external dependency.
- Layout and core actions work on narrow mobile screens and with keyboard navigation; connection, waiting, interruption, error, toppling, and game-over states are communicated accessibly.
- Browser compatibility, public signaling availability, and direct WebRTC connectivity remain explicit open validation risks until verified on real iPhone devices and supported browsers.
