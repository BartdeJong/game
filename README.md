# Skyline Dice

A small, mobile-first dice game for 2–5 players. The static TypeScript app is hosted on GitHub Pages. One player's browser is the host and the other devices connect directly to it with WebRTC; nothing is installed on players' phones.

## Play

1. Open the GitHub Pages URL on every device. The first page load needs internet.
2. The host taps **Host a game**, enters a name, and taps **Add a guest**.
3. Each guest opens **Join a game**, enters a name, and pastes the host's offer code.
4. The guest copies their answer code back to the host, who pastes it to connect them. Repeat the exchange for each guest.
5. Once 2–5 players are connected, the host starts the game. Keep the host page open and in the foreground.

Pairing exchanges compressed WebRTC connection descriptions as copy/paste codes. Use the **Copy** button where available, or select the code and copy it manually. Share codes privately with the intended player; they contain connection details. No room service, cloud signaling, STUN/TURN server, or relay is used. Both devices need the same Wi-Fi network. Network client isolation or browser restrictions may prevent a direct connection. Codes can be long, so use a message or other text-sharing method that preserves the full code.

The host browser generates the shared dice, validates actions, and owns the live match state. If the host closes or loses the page, the room cannot be recovered. A disconnected guest must be removed by the host; guests cannot rejoin a match already in progress, so restart the room if they need to return. iOS may suspend a background tab, so keep the host in the foreground. The app has not yet been verified on physical iPhones; local WebRTC and copy/paste pairing on iPhone Safari remain go/no-go tests.

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

The dev server is for development only and does not create a LAN room server. To test multi-device pairing, publish the build to GitHub Pages or serve the built files through a static server. Physical iPhone tests are required for local ICE connectivity, copying/pasting long codes, multiple guests, and background/resume behavior.

### Physical iPhone smoke test

- Open the published HTTPS page in Safari on the host and at least one guest iPhone.
- Copy the host offer code to the guest, then copy the guest answer code back to the host.
- Repeat pairing for up to four guests, then confirm everyone sees the same roll and resolved score.
- Confirm choices remain hidden until all connected players commit.
- Background and resume Safari, interrupt Wi‑Fi, and close a guest tab; verify status messages and host removal behavior.
- Check copy/paste behavior for full-length codes, including any line breaks added by the sharing method.

Direct same-Wi‑Fi WebRTC without a signaling or relay service is the principal feasibility risk. If these checks fail on the intended iPhone/browser/network combination, the no-relay architecture needs to change before this can be treated as a playable iPhone MVP.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` builds the site and publishes it from GitHub Actions on pushes to `main`. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The Vite base path is configured for this repository's `/game/` project URL.
