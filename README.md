# Skyline Dice

A small, mobile-first dice game for 2–5 players. The static TypeScript app is hosted on GitHub Pages. One player's browser is the host and the other devices connect to it with WebRTC; nothing is installed on players' phones.

## Play

1. Open the GitHub Pages URL on every device. The first page load needs internet.
2. The host taps **Host a game**, enters a name, and shares the short room code.
3. Each guest opens **Join a game**, enters a name and the room code. They join the same lobby automatically.
4. The host sets a points target (default 80, configurable from 10 to 200), and can add robots to play solo or fill open seats. Once there are 2–5 human and robot players, the host starts the game. Keep the host page open and in the foreground.
5. Players take turns in order and first choose to build or bank. Building rolls one die and lets the player add up to that many floors across their towers. Banking scores one tower and does not roll a die. Two wind dice are rolled after every player has taken a turn. Room win totals carry over between games.

Room codes are eight characters, displayed in two groups for readability. PeerJS Cloud is used only to introduce the browsers and exchange WebRTC setup messages; the game is configured for direct WebRTC connections with STUN and no TURN relay. The room code is an invite, so share it only with players in your game. Internet access is required for room setup. Using the same Wi‑Fi is recommended, but network isolation or firewall restrictions can still prevent a direct connection. The free shared signaling service may be unavailable or rate-limited; it is not an availability guarantee.

The host browser generates the shared dice, validates actions, and owns the live match state. The signaling service does not store game state. If the host closes or loses the page, the room cannot be recovered. A disconnected guest must be removed by the host; guests cannot rejoin a match already in progress, so restart the room if they need to return. iOS may suspend a background tab, so keep the host in the foreground. The app has not yet been verified on physical iPhones; short-code pairing and direct WebRTC on iPhone Safari remain go/no-go tests.

## Rules

- Players take turns in order. At the start of a turn, the active player chooses building or banking. Building rolls one six-sided die; click existing towers to add floors or a dotted slot to start one new tower in that position, spending up to that many floors across towers. Use the tower's **Undo one** button to take a floor back. You can have at most seven standing towers. Banking scores one tower and does not roll a die.
- After all players have taken a turn, the host rolls two six-sided wind dice and shares the same result with everyone. Banking protects that tower and scores `height × (height + 1) / 2`.
- Every unbanked tower is exposed to the shared wind once per round. It topples if the wind reaches its limit.
- Height limits are: 1 → 12, 2 → 11, 3 → 10, 4 → 9, 5 → 8, 6 → 7, and 7+ → 6.
- Every tower beyond the first shields the whole skyline by +1 wind strength, up to +3. The protection applies to all standing towers on each wind check.
- The host sets a room target from 10 to 200 points (default 80). The first player to reach the target wins and earns one room win.

New and extended towers are exposed to the shared wind at the end of each complete round. Players see their own towers and every player's score; opponents' towers and detailed moves stay hidden. When towers topple, every player's screen shows the same wind result and a falling-tower animation. Robots use the same build-or-bank choice as people. The in-game build log shows each player's choice and any build die, the shared wind, your own move and bank, and the per-player fall counts. Room win totals remain with the players when the host starts another game in the same room.

Each standing tower has a vertical 2–12 wind scale beside it: green totals are safe, coral totals can topple it, and the current shared wind is outlined after the roll.

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
- Repeat pairing for up to four guests, then confirm everyone sees the active player's die roll, turn, wind, and resolved score.
- Confirm each player chooses build or bank first; building rolls one die, while banking rolls none.
- Confirm the wind is rolled once after every player has taken a turn and the same result is shared with everyone.
- Confirm the host can change the default 80-point target in the lobby, the next round begins automatically after 3 seconds, and room win totals carry into a same-room rematch.
- Background and resume Safari, interrupt Wi‑Fi, and close a guest tab; verify status messages and host removal behavior.
- Confirm room codes work with lowercase input and optional hyphens/spaces.

Direct WebRTC without a TURN relay is the principal feasibility risk. PeerJS Cloud is a shared public signaling service, and its availability is outside this project's control. If these checks fail on the intended iPhone/browser/network combination, the connection architecture needs to change before this can be treated as a playable iPhone MVP.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` builds the site and publishes it from GitHub Actions on pushes to `main`. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The Vite base path is configured for this repository's `/game/` project URL.
