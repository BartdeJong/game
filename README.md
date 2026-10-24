# Skyline Dice

A small, mobile-first dice game for 2–5 players. The static TypeScript app is hosted on GitHub Pages. One player's browser is the host and the other devices connect to it with WebRTC; nothing is installed on players' phones.

## Play

1. Open the GitHub Pages URL on every device. The first page load needs internet.
2. The host taps **Host a game**, enters a name, and shares the short room code.
3. Each guest opens **Join a game**, enters a name and the room code. They join the same lobby automatically.
4. Once 2–5 players are connected, the host starts the game. Keep the host page open and in the foreground.

Room codes are eight characters, displayed in two groups for readability. PeerJS Cloud is used only to introduce the browsers and exchange WebRTC setup messages; the game is configured for direct WebRTC connections with STUN and no TURN relay. The room code is an invite, so share it only with players in your game. Internet access is required for room setup. Using the same Wi‑Fi is recommended, but network isolation or firewall restrictions can still prevent a direct connection. The free shared signaling service may be unavailable or rate-limited; it is not an availability guarantee.

The host browser generates the shared dice, validates actions, and owns the live match state. The signaling service does not store game state. If the host closes or loses the page, the room cannot be recovered. A disconnected guest must be removed by the host; guests cannot rejoin a match already in progress, so restart the room if they need to return. iOS may suspend a background tab, so keep the host in the foreground. The app has not yet been verified on physical iPhones; short-code pairing and direct WebRTC on iPhone Safari remain go/no-go tests.

## Rules

- Every round uses one shared roll of two six-sided dice. Their sum is the wind.
- After the roll is shown, each player secretly commits one move: start a tower, add one floor to an unbanked tower, or bank a tower.
- Once everyone commits, all moves are revealed together. Banking protects the tower and scores `height × (height + 1) / 2`.
- Every unbanked tower is then exposed to that round's wind. It topples if the wind is at least its limit.
- Height limits are: 1 → 12, 2 → 11, 3 → 10, 4 → 9, 5 → 8, 6 → 7, and 7+ → 6.
- The round in which anyone banks a third tower is the final round. Highest score wins; equal scores share the victory.

The roll is revealed before choices, and a newly started or extended tower is exposed to that wind. The in-game build log shows each roll, move, bank, and collapse.

## Run and test locally

Requires Node.js 20 or newer for development and builds. Players only need a mobile browser.

```sh
npm ci
npm test
npm run build
npm run dev
```

The dev server is for development only and does not create a LAN room server. To test multi-device pairing, publish the build to GitHub Pages or serve the built files through a static server. Physical iPhone tests are required for short-code joining, direct ICE connectivity, multiple guests, and background/resume behavior.

### Physical iPhone smoke test

- Open the published HTTPS page in Safari on the host and at least one guest iPhone.
- Enter the host's short room code on one or more guest iPhones and confirm they join automatically.
- Repeat pairing for up to four guests, then confirm everyone sees the same roll and resolved score.
- Confirm choices remain hidden until all connected players commit.
- Background and resume Safari, interrupt Wi‑Fi, and close a guest tab; verify status messages and host removal behavior.
- Confirm room codes work with lowercase input and optional hyphens/spaces.

Direct WebRTC without a TURN relay is the principal feasibility risk. PeerJS Cloud is a shared public signaling service, and its availability is outside this project's control. If these checks fail on the intended iPhone/browser/network combination, the connection architecture needs to change before this can be treated as a playable iPhone MVP.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` builds the site and publishes it from GitHub Actions on pushes to `main`. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The Vite base path is configured for this repository's `/game/` project URL.
