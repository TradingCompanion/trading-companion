# Trading Companion

Trading Companion is a desktop pet for traders. Yui, an anime-style 3D girl, lives on your desktop
and reacts to your trades. She stands on top of the taskbar,
breathes, blinks, watches your cursor, wanders around, and can be picked up and
thrown with the mouse. Everywhere except her body is click-through, so she never
gets in the way.

Built with Electron, Three.js and [@pixiv/three-vrm](https://github.com/pixiv/three-vrm).
Any **VRM** avatar works (VRoid Studio exports, VRoid Hub downloads, Booth models…).

## Run it

```bash
npm install
npm start
```

Windows, macOS and Linux (X11 with a compositor) are supported. On first launch
she appears at the bottom-centre of your primary monitor.

Build a release — a self-contained Windows folder, zipped:

```bash
npm run package
```

That runs `scripts/package.js`, which reads every file listed in `build.files` and **refuses to
build** if it finds an IP address, a websocket URL, a wallet-shaped string or a credential in any
of them. Run the scan on its own with `npm run package:check`. The zip is unsigned and needs no
admin rights to build; `npm run dist` still makes a signed installer via electron-builder, but
that path needs Windows Developer Mode enabled (it unpacks symlinks). Placeholders and test fixtures live
in `scripts/package-allow.txt`; anything not listed there stops the build.

## The website

`web/` is the landing page for trenchwaifu.fun, and the Yui standing on it is **the same
renderer as the desktop app** — same walk cycle, same drag and throw physics, same spring bones.
There is no second implementation to keep in step.

That works because `src/renderer.js` only ever talks to Electron through one object,
`window.pet`. `web/yui-boot.js` supplies a browser-shaped version of that bridge:

| the app does this natively | the browser version |
| --- | --- |
| `setIgnore` — makes the window click-through | toggles `pointer-events` on her canvas, so the page behind her stays usable |
| `onSettings` — settings.json | `localStorage`, so a visitor's changes to her survive a reload |
| `onModel` — the VRM over IPC | `fetch` with a streaming progress bar |
| `saveState` — remembers where she stands | same, in `localStorage` |
| `pickModel` — a native file dialog | a file input; the VRM never leaves the visitor's machine |
| native right-click menu | nothing; a click opens her settings, same as the app |

Touch events are forwarded as mouse events so she can be dragged on a phone, but only once she
has actually been grabbed — otherwise a touch near her would swallow the page scroll.

Her panel is the app's, markup and all. The handful of controls that only mean something on a
desktop — always on top, the sounds folder, Quit — are tagged `.web-hide` by an enhancer in
`yui-boot.js` that re-applies itself every time the renderer redraws the panel, and the relay
address and token fold away behind a "use my own relay" disclosure.

### The tour

A first-time visitor has no way of knowing a girl standing on a landing page can be picked up.
So she waves, and `web/yui-guide.js` walks through four things — pick me up, click me, dress me,
give me an address — each step completing only when the visitor actually does it. The signals are
real: `setState` in the renderer reports every state change to `window.__petOnState`, because
sampling on a timer misses a quick flick of the wrist. It is skippable, it remembers that it has
been seen, and the **?** in her dock replays it.

### Her wallet, in the browser

The relay is a plain WebSocket and the renderer opens it itself, so the website connects to the
same feed the desktop app does — the address field on the page and the one in her panel are the
same setting. The scheme follows the page: `ws://` from http, `wss://` from https.

**A page served over https can only open `wss://`.** The public relay is plain `ws://` today, so
the wallet feed on the live site needs TLS in front of the relay (a reverse proxy terminating
`wss://relay.trenchwaifu.fun` is enough; point `YUI_CONFIG.relay` at it). Until then it works
when the site is served over http — `npm run web` — and her panel says exactly why rather than
showing "connection failed".

```bash
npm run build:web     # bundle the renderer, copy her model and voice, generate pet.css
npm run web           # the same, then serve web/ on http://localhost:4173
```

Everything in `web/` except `index.html`, `yui-boot.js` and `yui-guide.js` is generated —
including `downloads/`, which picks up the zip from `npm run package`. Upload the folder as-is.
The only thing to edit is the `YUI_CONFIG` block at the top of `index.html` (mint, download URL,
socials, relay host); until the mint is filled in the page says the contract is not published yet
rather than showing a placeholder that could be mistaken for a real address.

## Connecting her to your trades

She needs somewhere to get trade events from, and **this download ships with no address and no
token in it**. Out of the box she connects nowhere; the Wallet tab is empty until you fill it in.

**She ships pointed at a public relay**, so the only thing to fill in is a wallet address. There
is no key to get and nothing to sign up for — worth saying because there is no free public
pump.fun feed either: PumpPortal answers `subscribeNewToken` to anyone but refuses
`subscribeAccountTrade` unless the connecting key is funded with at least 0.02 SOL, and meters it
per event. The relay exists so that nobody downloading her has to deal with any of that.

### Public mode

`PET_RELAY_PUBLIC=1` lets anyone connect without a token. A token inside a public download is not
a secret, so the relay runs on caps instead — set in `server/.env`:

| | default | |
| --- | --- | --- |
| `PET_MAX_SESSIONS` | 2000 | total sockets before new ones are refused |
| `PET_MAX_PER_IP` | 4 | connections from one address |
| `PET_MAX_WALLETS` | 3 | wallets an anonymous session may watch (extras are trimmed, not refused) |
| `PET_MAX_WALLETS_AUTHED` | 40 | the same for a session that does present the token |
| `PET_SEED_CONCURRENCY` | 4 | history queries in flight; the rest queue |

Matching is O(1) in the number of connected users: the signer and mint are pulled straight out of
the event text and looked up in a Set, rather than searching each event once per watched wallet.
`GET /health` reports `eventsUnparsed` — if that climbs with `eventsSeen`, the upstream event
format has changed and nothing will match until the regexes in `pet-relay.js` are updated.

`node server/test-relay.js` runs the relay against a fake firehose and checks matching, fan-out
and every limit above (18 checks). It needs no database — a failed seed is one of the paths it
covers, since a relay whose database is down must still tell the pet about trades.

**Prefer to run your own?** The server is in the download. Point `FIREHOSE_URL` at your own feed
and set a token, and she is entirely yours.

### What she can and cannot see

The relay listens to the pump.fun firehose, which carries **bonding-curve trades**. Once a token
graduates it trades on Raydium or PumpSwap and those fills do not appear in that feed — she will
stay quiet on them however the relay is configured. The Wallet tab shows how many trades have
actually arrived, so "connected but silent" is visible rather than something you have to guess at.

### Your own details

Nothing private is committed or packaged. To prefill the relay boxes on your own machine, put a
`relay.local.json` next to `main.js`:

```json
{ "relayUrl": "wss://your-relay.example:9998", "relayToken": "…" }
```

It is git-ignored and absent from `build.files`, so it never reaches a release. Your wallet
addresses are only ever stored in `settings.json` under your own user profile
(`%APPDATA%/desktop-pet` on Windows), which is not part of the app folder and never packaged.

## What she does

| You do | She does |
| --- | --- |
| nothing | breathes, shifts her weight, blinks, follows your cursor with her eyes and head, occasionally stretches, hums, looks around or walks somewhere else |
| hover over her | notices you and smiles |
| **drag her** | hangs from wherever you grabbed her and swings like a pendulum, legs kicking, hair and skirt flying. Grab a foot and she dangles upside-down |
| let go / throw her | flies with the cursor's velocity, flails, rights herself in the air, lands with a squash, bounces off screen edges |
| shake her hard or throw her very hard | gets dizzy for a few seconds |
| click her | waves and opens her settings panel (voice, size, model, wallet, sounds) |
| double-click her | jumps |
| right-click her (or the tray icon) | menu: wave, sit, stand, walk, load another VRM, size, always-on-top, quit |
| ignore her for a couple of minutes | sits down on the taskbar and relaxes |

## Trade reactions

Click her → **Wallet** section. Paste your wallet address(es), the relay URL and token,
press **Connect**. From then on every buy and sell your wallet makes on pump.fun reaches
her within a second:

| Event | She does |
| --- | --- |
| buy | perks up, "Ooh, $SYM! 0.5 SOL in. Good luck~" |
| sell at a profit | arms up, hops, happy sound, "+0.61 SOL on $PEPE~" (bigger than 1 SOL or +100% → the big-win sound) |
| sell at a loss | leans in, hands together, soft sound, "It's okay… only −0.24 SOL. Next one." |
| flat sell | "Clean exit~" |

Clicking her opens her settings beside her — four tabs: **Her**, **Look**, **Board**, **Wallet** —
and the panel follows her as she moves. Clicking her again, or picking her up, puts it away rather
than dragging it across the screen with her.

Her **Look** section in the settings panel covers bust size and bounce, outfit colour scheme
(including fully custom colours), top style (full / sleeveless / crop / bikini), bottom style
(skirt / bikini), cleavage depth, skirt length, ribbon on or off, and hair and eye colour.
Everything is applied live by recolouring and cutting the model's own textures, so any VRM
with VRoid-style material names works.

The bounce slider softens her chest springs and then scales the swing the solver produced,
so at 100% the jiggle carries on roughly a second after a landing instead of dying out in a
couple of frames. It stops short of the point where the mesh would push through her top.

Every win makes her **glow**: a golden rim and halo, sparkles drifting up, fading over about
fifteen seconds. Every loss leaves a mark: pale skin, a bruised cheek, a band-aid, a nosebleed;
big or repeated losses add a cut brow, a black eye, a split lip and scrapes on her arm and
knee. She heals over a couple of minutes, and a profit patches her up faster.

Profit and loss are realised PnL against the average cost of what you sold, so partial
exits are handled. Cost basis is seeded from the harvester's trade history when you connect.
A fill that lands while that history is loading is matched against it (by transaction
signature when the `trades` table has one, otherwise by mint, side and amounts) so it is never
counted twice.

## The PnL sign

She keeps a stack of little signs behind her back. Open a position and she reaches back, pulls
one out and holds it up:

```
 $PEPE
 +0.500 SOL
 +50.0%
```

The board is green in profit and red at a loss. It is **marked to market live**: the relay
forwards a throttled price tick whenever *anyone* trades a mint you are holding, so the number
moves with the chart, not just with your own fills.

The value comes from the **token's own market cap**, never from the raw quote amount on a
trade. A pump.fun token is not always paired against SOL — stock-paired launches quote in the
tokenised stock — so `quoteAmount / tokenAmount` is not a comparable price and can be
mislabelled as SOL, which is what produced nonsense numbers on those pairs. Market cap is
always denominated in that token's own quote asset, so `cur_mc / entry_mc` is correct whatever
the pair is. Supply is fixed at 1e9, so the position value is `mc × Σ(costᵢ / mcᵢ)`, and
multiplying the ratio by what you actually spent gives an honest PnL in the currency you spent
it in. Tokens the feed reports no market cap for fall back to the per-trade price. Buying a different token makes her stash
that sign and pull out a new one. Close everything and she swaps to a **SESSION** board with
your realised total since launch. She puts it away while she is being dragged, thrown or
dizzy, and picks whichever hand has room so the board never runs off the screen edge.

Only positions **opened while she is watching** raise a sign. Bags you already held when the
relay connected are tracked for PnL but stay in her pocket, so she does not greet you with a
board the moment she starts up.

Hover the board and a **×** appears in its corner; click it and she puts that sign away. It
stays away until the content changes (a new token, or going flat). Only the × itself catches
the mouse — clicks anywhere else on the board pass straight through to the chart behind it.

The market cap is shown **in dollars**, converted with the SOL price from the settings panel
(default 101.95). A pair with no known dollar rate falls back to its own quote units.

She can hold it **one-handed or in both hands**, set by **Hold**. Both hands is the default.

One-handed she grips the post rather than balancing the board on an open palm: her fingers close
into a fist, the post is drawn at whichever point her knuckles are, and the board sits a little
behind her hand so the fingers occlude it. She picks one of four arm positions at random, from
high beside her head to low at her chest.

Two-handed there is no post. She grips the board's **left and right edges**, wrists rolled so
her palms face inward and her fingers wrap the edge — without that roll her palms face up and
the hands read upside down.

The board is fitted to her grip every frame: it takes its centre and its width from where her
two hands actually are, measured as they appear on screen, so it stays in her hands whatever
she is doing. Anchoring it to a fixed spot did not survive her turning to follow the cursor,
which left the board hanging in mid-air beside her. She also squares up to the viewer while
presenting one. Because the board has to meet her hands, its width is her grip span plus a
little overhang, and **Sign size** only widens that overhang — it cannot stretch her arms.

Buying several tokens in a row will not leave her flipping boards: one that is up earns a
minimum time on screen before a newer position can replace it, and it keeps re-pricing itself
while it waits. When more than one position is open the board says how many. A relay
reconnect resends your open bags as history, and she keeps showing them rather than going
blank. Repeated trades also share a voice cooldown so she does not machine-gun her lines.

## Her settings panel

Clicking her opens a tabbed panel: **Her** (size, model, always-on-top, voice), **Look**
(figure, outfit, colours), **Board** (the PnL sign and its test buttons) and **Wallet** (address,
relay, sounds folder). Every control lives in the DOM at all times and tabs only hide the
inactive pages, so nothing loses its wiring when you switch. The footer carries a **build
stamp** — if it is older than a change you expect, you are looking at a stale build; relaunching
from the desktop shortcut closes any running pet first, so it always starts the current one.


two-tone capsule with a stitched seam, a little embroidered face on the white half and
pump.fun on the green half. It uses the same two-handed grip the boards do, so her hands land
on its ends. A position board always outranks it, and after you go flat the session total stays

There are ten board looks, chosen with **Board style**: Neon glass, Chalkboard, Whiteboard,
Terminal, Paper placard, Neon tube, Metal plate, LED matrix, Kawaii pastel and Holographic.

Toggle it and set its size under **Wallet** in her settings panel. **Test position** there pulls
out a demo board with a made-up ticker whose market cap wanders for half a minute, so you can
frame her on stream without opening a real position. It needs no relay connection, it is
labelled `demo` on the board, and a real fill takes the board straight back.

### The relay (server side)

`server/pet-relay.js` runs on the box that has the firehose. It reads
`ws://127.0.0.1:9999`, keeps a per-wallet cost basis, and serves the pet on port 9998
behind a token:

```bash
cd server && npm install
pm2 start pet-relay.js --name pet-relay && pm2 save
```

Price ticks for held mints are throttled by `PET_PRICE_MS` (default 400 ms).

Config in `server/.env` (`PET_RELAY_PORT`, `PET_RELAY_HOST`, `PET_RELAY_TOKEN`, `PET_PRICE_MS`, `PET_RELAY_SIMULATE=1` to enable the testing-only `POST /simulate` endpoint,
`FIREHOSE_URL`); the token falls back to `server/.token`. Database credentials come
from the harvester's `.env`. `GET /health` reports firehose and client state.

## Voice

She has no recordings. `src/voice.js` synthesises her with Web Audio: a pulse glottal
source with vibrato, three formant filters gliding between vowels, and a breath layer.
Each sound is a short script of segments (see `PHRASES`). Every event has a sound slot
in the settings panel; pick a phrase or silence per event, and set pitch/volume.

## Using your own model

Right-click her → **Load VRM model…** and pick a `.vrm` file. VRM 0.x and 1.0 are both
supported. Models with spring bones (hair, skirts, ribbons) look best because those
react physically to being dragged around. Facial expressions use the standard VRM
presets (happy / sad / surprised / relaxed / blink / mouth shapes).

Bundled models:

| File | Author | License |
| --- | --- | --- |
| `models/shino.vrm` (default) — Sendagaya Shino | VRoid Project sample | CC0 |
| `models/three-vrm-girl.vrm` | pixiv Inc. | VRoid Hub license, redistribution allowed, no credit required |
| `models/twist-sample.vrm` | pixiv Inc. | VRM Public License 1.0, everyone may use |

## How it works

- `main.js` — Electron main process. Creates one transparent, frameless, always-on-top
  window the size of the work area, polls the cursor position, and toggles
  `setIgnoreMouseEvents` so clicks pass through everywhere except her body. Also the
  tray icon, context menu, model picker and settings persistence.
- `src/renderer.js` — everything else. Renders her with a perspective camera into a small
  canvas (about twice her height) that follows her around the screen, so each frame only
  repaints that region rather than the whole desktop. Loads the VRM, runs a procedural animation rig
  (per-bone smoothed pose targets layered with breathing, sway, walk cycle, etc.), a
  2D rigid-body sim for the root (gravity, walls, floor, squash on impact) and a
  driven pendulum for dragging (the body hangs from the grab point and reacts to
  cursor acceleration). States: idle, walk, sit, grabbed, falling, landing, wave,
  dizzy. Hair/skirt physics come from the VRM spring bones.

Settings (model path, size, position, always-on-top) are stored in Electron's
`userData` folder as `settings.json`.

## Self-test

```bash
npm test
```

Runs headless under Xvfb, drives her through every state with synthetic input,
asserts on the resulting physics state and writes screenshots (`01-idle.png` …
`13-righted.png`) next to `main.js`, or into `PET_TEST_OUT` if set.
