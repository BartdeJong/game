# Skyline Dice — Project Plan

**Status**: Approved
**Created**: 2026-10-24
**Mode**: Standard

## 1. Project Overview

Build Skyline Dice as a minimal, mobile-friendly TypeScript browser game for 2–5 players, including iPhone browsers, with nothing to install. The static app is published free on GitHub Pages. For a live match, the host's browser is authoritative and connects directly to each guest browser using a separate WebRTC data channel, paired manually by copying and pasting offer/answer codes. The host is also a player.

No accounts, database, online signaling/relay, persistent preferences, or match history are in scope. Active match state exists only in the host browser's memory.

## 2. Goals and Scope

- Implement the approved MVP rules and defaults in section 4.
- Let a host create a 2–5 player room and play alongside guests, with no extra app or software installed.
- Provide an easy lobby, shared round roll, simultaneous choices, resolution feedback, score display, and final result.
- Publish the static frontend through free GitHub Pages hosting and use manual text offer/answer exchange for local peer pairing.
- Keep the UI and interactions usable on phones, tablets, and desktop browsers.

Out of scope: accounts, cloud signaling or relays, online rooms, matchmaking, saved games, chat, spectator mode, automatic LAN discovery, and host migration.

## 3. Architecture and Game Flow

**Static frontend**: TypeScript with plain HTML/CSS and Pico.css, built as static assets and published on GitHub Pages over HTTPS. There is no Node.js server, backend, or hosted room service. The host and guests open the same static app in their browsers. GitHub Pages requires internet for the initial page load unless the browser already has a usable cached copy.

**Host-authoritative peer architecture**: The host browser owns all active room state, generates the shared dice result, validates player actions, resolves rounds, scores, and distributes authoritative updates. It creates a separate WebRTC peer connection and data channel for each guest. Guest browsers send actions only to the host; guests do not connect to one another. The host is included as a player and applies the same game rules locally. No Azure resources, cloud signaling, STUN/TURN service, or relay is planned.

**Manual pairing flow**:
1. Host and guests open the GitHub Pages app in their browsers. The host creates a room and enters a display name.
2. For each guest, the host creates a WebRTC offer and displays it as a selectable text code. The guest copies/pastes it, creates an answer, and displays their answer code.
3. The host pastes that guest's answer code. The browsers complete ICE negotiation from the exchanged offer/answer information and establish a direct local data channel. Repeat separately for each guest. No signaling data is sent to a cloud service.
4. Once 2–5 players, including the host, are connected, the host can start. Each player commits one private choice per round; the host reveals choices together only after all active players have submitted, then sends the resolution and updated board to each guest.

The handshake must gather and encode the required local ICE candidates before showing each code. Copy buttons should use the Clipboard API when available, with selectable text as a manual fallback. No camera permission is required. There is no fallback LAN URL, server, cloud signaler, or relay in this design. Manual pairing is less convenient than a share link, and codes can be long or altered by text-sharing methods.

**Round flow**: show the round's shared 2d6 wind result → collect simultaneous choices → apply valid build/bank actions → topple exposed towers according to the wind table → publish scores and any game-ending result → begin the next round if the game is not over.

**Connectivity and lifecycle constraints**: WebRTC direct local connectivity depends on the iOS browser, Wi-Fi network, and local ICE candidate behavior; same-Wi-Fi access alone does not guarantee peer connectivity (for example, client isolation or browser restrictions can prevent it). This must be verified on real iPhones before implementation is considered viable. A disconnected guest's seat/state remains only in host memory and the round may pause while the guest is paired again or the host removes them; exact recovery behavior is a validation item. There is no host migration. If the host closes the page, the host browser is backgrounded or suspended, or the device/browser loses the active page, the match may be interrupted or lost. Active state is not persisted or recoverable from another device.

**Product constraints to communicate in the UI/help**: GitHub Pages needs internet for initial load unless cached; same-Wi-Fi/local peer connectivity is required; pairing is a manual two-way code exchange for every guest, and codes should be shared privately; Safari backgrounding/closing can interrupt the host. No cloud signaling or relay is available to work around local connectivity failures.

## 4. Game Rules and Approved Defaults

**Approved baseline**:
- Each round has one shared roll of two standard six-sided dice.
- Each player simultaneously performs one action: add one floor to an existing unbanked tower, start a new one-floor tower, or bank one existing tower.
- After the action and shared wind roll, every unbanked tower that meets its height-specific toppling limit is lost.
- Banking scores triangular points for that tower's height.
- The round in which any player banks a third tower is the final round.

**Approved MVP defaults**:

| Mechanic | Approved playable default |
|---|---|
| Wind strength | Sum of the two dice, from 2–12. |
| Toppling test | An unbanked tower topples when wind strength is greater than or equal to its height's limit. |
| Height → wind limit | Height 1: 12; 2: 11; 3: 10; 4: 9; 5: 8; 6: 7; 7 or higher: 6. |
| Roll/choice timing | Reveal the shared roll first; players then privately commit simultaneously, so choices may respond to that roll. |
| Build exposure | Apply the chosen build before the toppling test; a newly started or extended tower is exposed to that round's wind. |
| Banking | A bank action secures one existing tower before wind resolution and scores `height × (height + 1) / 2`; no other action is taken by that player that round. |
| Final round | If any player banks their third tower, complete that round's wind resolution, then end the game. |
| Winner/ties | Highest total banked score wins; equal highest scores are a shared tie. |
| Room start | Host can start with 2–5 connected players. |

These approved limits and timing choices materially affect risk and strategy; surface them in the game rules/help panel.

## 5. State, Validation, and Deliverables

**Ephemeral room state**: room status and round number; connected player IDs/names; each player's unbanked tower heights, banked tower count, and score; shared dice result; pending choices; and final result. Store active state only in the host browser's memory. Do not create user accounts, durable identifiers, or match history.

**Host validation**: enforce room capacity and game phase; accept one valid action per connected player per round; ensure tower references exist and banking/build choices are legal; prevent duplicate submissions and guest-side score/dice edits; and resolve each round exactly once before broadcasting authoritative state.

**Deliverables**:
- TypeScript responsive static game frontend, local copy/paste pairing flow, and accessible rules/help content.
- Host-authoritative WebRTC data-channel protocol with one direct connection per guest; no server or relay.
- GitHub Pages build/deployment workflow for the static frontend.
- User instructions for initial load, same-Wi-Fi requirements, per-guest offer/answer code exchange, connection limitations, and restarting a lost room.
- Unit tests for rules/state transitions and a real-device iPhone Safari smoke-test checklist.

## 6. Design System & UI

**Component Library**: Pico.css
**Visual direction**: clean skyline/architecture motif, high-contrast dice and tower state, restrained color, and clear risk feedback. Use semantic HTML and native form controls styled consistently rather than introducing a heavier component framework.

**Screens and key interactions**:
- **Host / Join**: room creation and host name entry; selectable host offer code and copy action; guest name and offer-code form; guest answer code and copy action; host answer-code form; clear pairing and connectivity status. Explain that each guest is paired separately, codes should be shared privately, and no link/server fallback is available.
- **Lobby**: player list, host indicator, capacity status, connection status, and host-only start control enabled at 2–5 players.
- **Game board**: player score/banked count, distinct tower cards with height and current wind limit, shared dice result, round status, and action controls for build, new tower, or bank. Choices remain private until all active players submit; show a waiting state and allow a player to revise only before submission.
- **Resolution**: reveal simultaneous choices, tower collapses/banking, points gained, and updated scores; explain why each tower toppled.
- **Results**: winner or shared tie, final scores, and host option to start a fresh room (no history retained).

Use responsive layouts and keyboard-accessible controls, labels, focus states, and status announcements. Do not rely on color alone to distinguish safe, at-risk, banked, or toppled towers.

## 7. Implementation Plan

1. Validate feasibility first on real iPhones: confirm Safari WebRTC local ICE connectivity and data-channel exchange on the intended same-Wi-Fi setup, copy/paste behavior in both roles, and code integrity when transferred between devices. Treat failure as a blocker requiring a revised connection design; do not assume viability from desktop emulation.
2. Define typed game-state/action models and pure rule-resolution functions using the approved defaults.
3. Build the static responsive app and browser-only text offer/answer exchange; establish and manage a separate host-to-guest WebRTC data channel for every guest, with no cloud signaling or relay.
4. Implement host-authoritative in-memory room lifecycle, action validation, round resolution, and broadcast of state over the data channels.
5. Build the responsive lobby, game board, simultaneous action flow, resolution, and results screens; provide clear connection/backgrounding guidance.
6. Configure and verify the static GitHub Pages build and publishing workflow.
7. Add rules/limitations documentation and complete real-device smoke tests for an iPhone Safari host and iPhone Safari guests.

## 8. Acceptance Criteria and Tests

- A room supports 2–5 players, including the host; a sixth player is rejected with a clear message.
- A host can pair each guest by sharing the offer code, receiving the answer code, and submitting it, with no online signaling or relay.
- An iPhone Safari host and iPhone Safari guest can establish a direct same-Wi-Fi WebRTC data channel on real devices; this is a go/no-go feasibility criterion.
- All clients show the same host-generated 2d6 result and resolved state.
- Choices remain hidden until all connected active players submit; duplicate, invalid, or late actions do not alter state.
- Tests cover each height threshold boundary, newly built tower exposure, banking before wind, triangular scoring, tower loss, and ending after the round in which a third tower is banked.
- Final winner/tie and scores match across host and guests; host memory is the sole active state and no host migration or durable recovery is supported.
- The real-device smoke test covers iPhone Safari in both host and guest roles, same-Wi-Fi peer connectivity, multiple separately paired guests, full-length code copy/paste integrity, background/resume interruption, guest disconnect, and clear failure messaging.
- The frontend builds and publishes as a static GitHub Pages site with no server, signaling service, or relay; documentation states that first load needs internet unless cached.
- Layout and core actions work on narrow mobile screens and with keyboard navigation; connection, waiting, interruption, error, toppling, and game-over states are communicated accessibly.
- Browser compatibility and code-transfer integrity remain explicit open validation risks until verified on real iPhone devices and supported browsers.
