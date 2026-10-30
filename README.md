# Skyline Dice

A small, mobile-first dice game for 2–10 players. The static TypeScript app is hosted on GitHub Pages and can be installed as a Progressive Web App (PWA). One player's browser is the host and the other devices connect to it with WebRTC.

## Play

1. Open the GitHub Pages URL on every device. The first page load needs internet.
2. The host taps **Host a game**, enters a name, and shares the short room code.
3. Each guest opens **Join a game**, enters a name and the room code. They join the same lobby automatically.
4. The host sets a points target (default 80, configurable from 10 to 200), toggles the die-roll animation, and can add robots to play solo or fill open seats. Once there are 2–10 human and robot players, the host starts the game. Keep the host page open and in the foreground.
5. At the start of each round, the host automatically rolls one die for every player. When enabled, each player briefly sees their own animated die full-screen; all results remain in the shared roll bar either way. Players then choose to build or bank and submit turns in parallel. Building lets a player add up to the rolled number of floors across their towers. Banking scores one or more chosen towers, up to the number rolled; players may bank fewer. Two shared wind dice are rolled after all players submit. Room win totals carry over between games.

Room codes are eight characters, displayed in two groups for readability. PeerJS Cloud is used only to introduce the browsers and exchange WebRTC setup messages; the game is configured for direct WebRTC connections with STUN and no TURN relay. The room code is an invite, so share it only with players in your game. Internet access is required for room setup. Using the same Wi‑Fi is recommended, but network isolation or firewall restrictions can still prevent a direct connection. The free shared signaling service may be unavailable or rate-limited; it is not an availability guarantee.

The host browser generates the shared dice, validates actions, and owns the live match state. The signaling service does not store game state. The app saves a recovery copy of the host match and guest resume credentials in each device's browser storage. If a page is closed or reloaded, reopen the game in the same browser or installed app and choose **Resume host room** or **Rejoin** on the home screen. The host must resume first so guests can reconnect; they return as their original players, including during an active match. Recovery depends on that browser or installed app retaining its site data and on the room code becoming available again; clearing site data or using private browsing can prevent recovery. Intentionally leaving a room clears that device's saved recovery record. iOS may suspend a background app, so keep the host in the foreground.

## Install and offline use

Install Skyline Dice from the browser menu (for example, **Install app** in Chrome or **Add to Home Screen** in Safari). The installed app opens without the browser's address bar. Its app shell and previously loaded game files are cached, so the interface can open offline after the first successful online visit. Creating or joining a room, reconnecting players, and playing multiplayer still require internet access. Browser storage for the installed app may be separate from the regular browser tab; reopen a saved game in the same app or browser where it was started.

## Rules

- Players act in parallel. At the start of each round, the host automatically rolls a six-sided die for each player. After the animated roll, choose **Build** or **Bank**. Build floors across existing towers or start at most one new tower, up to the die result. Use **Undo one** to take a floor back. Up to six towers can stand. Each tower displays its bank value, `height × (height + 1) / 2`.
- Banking lets a player choose one or more towers, up to the die result; they may bank fewer. Each chosen tower scores its bank value and is removed from the standing skyline before wind protection is calculated.
- If any player reaches the target after bank points are awarded, the game ends immediately and no towers topple that round. Otherwise, calculate protection from the towers still standing, then check all standing towers against the shared wind together.
- Each standing tower beyond the first adds +1 to the wind limit of every standing tower, up to +3. Banked towers have already been removed, so they do not contribute protection. This protection is calculated once and stays fixed for the whole wind check.
- A tower topples when the total of the two wind dice is equal to or greater than its base limit plus protection. Base limits are: height 1 → 12, 2 → 11, 3 → 10, 4 → 9, 5 → 8, 6 → 7, 7 → 6, 8 → 5, 9 → 4, 10 → 3, and 11 or higher → 2.
- The host sets a room target from 10 to 200 points (default 80). The first player to reach the target wins and earns one room win.

New and extended towers are exposed to the shared wind at the end of each complete round. Players see their own towers and every player's score; opponents' towers and detailed moves stay hidden. A player's own submitted growth remains visible while others finish their turns. When towers topple, every player's screen shows the same wind result and a falling-tower animation. Robots use the same build-or-bank choice as people. The host can set each robot to Easy, Normal, Hard, Ultra Hard, or Extreme Robot in the lobby: Easy uses simple rules, Normal considers exact wind risk, Hard compares legal bank/build options and tower placements against expected wind outcomes, Ultra Hard adds a next-round lookahead, and Extreme Robot progressively searches up to its per-robot depth setting (1–500 future turns, default 8) without a time limit, while assuming an opponent will take an available winning bank. Very high depths can take an impractically long time. Robot decisions run in separate Web Workers so multiple robots can search at the same time. Room win totals remain with the players when the host starts another game in the same room.

Each standing tower has a vertical 2–12 wind scale beside it: green totals are safe, coral totals can topple it, and the current shared wind is outlined after the roll.

## Run and test locally

Requires Node.js 20 or newer for development and builds. Players need a modern mobile browser; installing the PWA is optional.

```sh
npm ci
npm test
npm run build
npm run dev
```

The dev server is for development only and does not create a LAN room server. To test PWA installation and offline launch, build and serve the app over HTTPS (localhost is also treated as secure), install it from the browser, open it once online, then enable airplane mode and reopen it. The game shell should load; multiplayer room actions should report that a connection is unavailable. To test multi-device pairing, publish the build to GitHub Pages or serve the built files through a static server. Physical iPhone tests are required for short-code joining, PWA installation, direct ICE connectivity, multiple guests, offline launch, and background/resume behavior.

### Physical iPhone smoke test

- Open the published HTTPS page in Safari on the host and at least one guest iPhone.
- Enter the host's short room code on one or more guest iPhones and confirm they join automatically.
- Repeat pairing for up to nine guests, then confirm each player sees their own skyline and the shared bar with every player's choice, build die, and round score, followed by the wind result.
- Confirm each player's die rolls automatically with a full-screen animation at the start of each round, then each player can choose to build or bank and submit while others are still deciding. Verify banking allows selecting fewer towers than the roll, but never more.
- Confirm every player's die appears in the roll bar and the wind is rolled once after all players submit, with the same result shared with everyone.
- Confirm the host can change the default 80-point target and toggle the roll animation in the lobby, the wind result stays visible for 8 seconds before the next round, and room win totals carry into a same-room rematch.
- Background and resume Safari, close/reopen the host and guest pages, and verify the host can restore the room before guests rejoin with their saved identities.
- Interrupt Wi‑Fi and confirm the room service reconnects or the saved game can be resumed without losing the current turn.
- Confirm room codes work with lowercase input and optional hyphens/spaces.

Direct WebRTC without a TURN relay is the principal feasibility risk. PeerJS Cloud is a shared public signaling service, and its availability is outside this project's control. If these checks fail on the intended iPhone/browser/network combination, the connection architecture needs to change before this can be treated as a playable iPhone MVP.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` builds the site and publishes it from GitHub Actions on pushes to `main`. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The Vite base path is configured for this repository's `/game/` project URL.
