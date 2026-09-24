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

`web/` holds three pages. `app.html` is **the app in a tab**: no page around her, the app's own
defaults, the first-run tour, the greeting, streaks, the sell nudge — everything the desktop build
does that a browser can do. `index.html` is the landing page — hero, what she does, live demo
chips, how it works, the wallet box, the download, the open-source block, the roadmap — and
`docs.html` is the long-form documentation with a contents column. On all of them the Yui you
see is **the same renderer as the desktop app** — same walk cycle, same drag and throw physics,
same spring bones. There is no second implementation to keep in step.

**The starter.** The front page opens on the terminal, not the hero: `web/yui-starter.js` puts
Paperxiom's page in front of everything, replaying a real launch (`web/trade/tapes/<mint>.json`,
exported from the harvester's Postgres by `scripts/tape-from-db.js <mint> --freeze "<utc time>"`)
frozen a moment before it ran, with her beside it. One guided paper trade: the hint points at
Buy (1 SOL, presets locked), she takes the position, playback runs to the tape's top and stops
itself there (`stopAt`), the hint points at Sell, and her win reaction is the real one. Then the
starter slides away and the first-visit hello runs underneath. Everyone gets the starter; a
returning visitor gets a Skip at the top right. The terminal's replay transport is hidden unless
the page is opened with `?rmt=1`.

**The paper terminal.** `web/trade/` is the lesson's chart — Paperxiom's token page — Axiom's captured chrome, a
lightweight-charts pane with trade bubbles, paper orders on the real pump.fun bonding curve —
copied whole from the paper-axiom checkout by `build-web.js` (`PAPERXIOM_DIR`, default
`../../EVERYTHING/paper-axiom`; the copy is git-ignored) and shown by the starter's overlay. It replays a real
launch from a tape (see **The starter**), renamed `$TEST` for the lesson. `web/trade/pa-yui.js` is the bridge: it wraps the page's `API.buy`/`API.sell` and posts
each fill to the parent shaped exactly like the relay's `trade` message (SOL amounts, the market
cap it printed at, realised PnL on a sell against the cost of what was sold), and posts the
chart's last bar as a `price` tick while it moves; `yui-page.js` hands both to `__petRelayMsg`,
the handler real trades go into. The messages carry `paper: 1`, which is what lets her keep the
board up without a relay connection.

`web/yui-page.js` makes the pages hers. **A first visit is gated**: the page sits behind glass
(`#yui-intro`, above the header and below her) while she walks over from further in, waves,
says hello and asks your name — the beginning of the app's own tour. Giving a name frees the
page; the rest of the tour carries on and every later step can be skipped. The gate is
remembered per browser (`yui.web.intro.v1`); a visit that leaves before the name meets her
again. After that, buttons and cards carry `data-yui-say` / `data-yui-mood` (a wave, a wince, a
hop) and `data-yui-hover`; a click on the bare page walks her over; two quick clicks make her
jump; the wallet going live gets confetti; coming back to the tab gets a wave. Everything is a
nudge to states she already has, through three renderer hooks (`__petWalkTo`, `__petJump`,
`__petPoke`) — nothing is animated by hand, and none of it runs while her tour or panel is up.
Where she was left is remembered per page.

Her defaults on the web are not written twice either: `scripts/build-web.js` reads
`defaultSettings()` out of `main.js` and generates `web/yui-defaults.js`, so a change to how she
ships in the zip is a change to how she loads in a tab. `yui-boot.js` applies the few overrides a
browser needs on top (relay URL follows the page, no display picker, size capped to the window)
with the reason next to each. A page may adjust a default through `YUI_CONFIG.defaults` — the
landing page turns the app's tour off because it has its own — and size her through
`YUI_CONFIG.size(w, h)`.

Every visitor has their own Yui: settings live in that browser's `localStorage`, and each socket
to the relay carries its own wallets. Nothing is shared between visitors.

**Performance in a tab.** The renderer picks a lighter profile when `window.pet.web` is set
(the bridge sets it): no supersampling (the display's own pixel density, capped at 2×), 60 fps
active / 30 calm instead of 144 / 60, effects canvas at ≤ 1.5×. The pages avoid anything the
compositor would redo on every frame she moves — no `backdrop-filter` (the header, the dock and
the first-visit glass are plain translucent), no rotating gradients — and the marquee is a
composited transform. Her body ships without the VRM's 2.5 MB preview thumbnail and with a
pre-gzipped twin the server hands out as `Content-Encoding: gzip` (14.4 → 8.7 MB on the wire;
`X-Uncompressed-Size` keeps the progress bar honest). The first visit shows her download
progress on the glass rather than a dark page.

Both pages are served from the relay box by `scripts/serve-web.js`, and `npm run build:web`
there is the deploy — a refresh picks it up:

- pm2 `yui-web` — `PORT=8820 INDEX=app.html`, reachable directly at http://192.248.179.126:8820/.
  The relay is on the same host, so she connects over plain `ws://` with nothing to configure.
- pm2 `tradingcompanion-web` — `PORT=8821 INDEX=index.html`, previewable at http://192.248.179.126:8821/ and behind Caddy as
  **tradingcompanion.fun** / www. Caddy also terminates TLS for `relay.tradingcompanion.fun` and hands the
  socket to the relay on 9998, which is why `index.html` pins `relay: 'wss://relay.tradingcompanion.fun'`.
  DNS lives at Namecheap; the site is live as soon as the three A records point at this box.

```bash
npm run test:web       # headless: load app.html in Electron's Chromium, drive the same hooks as npm test
npm run test:web:tour  # the first-run tour end to end with real (trusted) mouse and keyboard input
npm run test:web:page  # the landing page as an experience: scroll-walking, page clicks, the docs page
YUI_TEST_WALLET=<address> npm run test:web:tour   # …including the wallet step against the live relay
```

`test:web:tour` exists because the hooks dispatch on the window and never touch DOM hit-testing:
"can a person click this button" is a different question from "does the physics work", and the
first web build shipped with the tour card stacked *under* her canvas — every hook-driven check
passed while nobody could type their name. Three things in the browser build exist for the same
reason and are worth knowing about: everything she shows stacks above her stage (tour > panel >
bubble > canvas); a real press on the empty page is withheld from the renderer, as it is on the
desktop where the window is click-through there (so a click beside her cannot close the panel a
tour step just opened); and the grab cursor lives on her canvas alone.

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
So she waves and runs **the app's own first-run tour** — the same seven steps, the same code —
greeting them by asking their name, then click me, pick me up, dress me, connect a wallet, a test
buy, and what she does. Only the words change: the browser bridge sets `home: 'page'`, so she says
she lives at the bottom of the page rather than on the taskbar. She stands on the left
(`YUI_CONFIG.spawn`) at the app's size so the hero keeps the middle; on a narrow window the hero
and footer reserve her height instead. The **?** in her dock replays the tour, and the page's own
"watch an address" box (`web/yui-wallet.js`) is bound to the same wallet setting as her panel.

### Her wallet, in the browser

The relay is a plain WebSocket and the renderer opens it itself, so the website connects to the
same feed the desktop app does — the address field on the page and the one in her panel are the
same setting. The scheme follows the page: `ws://` from http, `wss://` from https.

**A page served over https can only open `wss://`.** The live site is served over https, so it
pins `YUI_CONFIG.relay` at `wss://relay.tradingcompanion.fun` — Caddy terminates TLS there and
hands the socket to the relay on 9998. A local preview over http — `npm run web` — talks to the
relay directly over `ws://`, and if a page ever ends up on https with a plain `ws://` relay, her
panel says exactly why rather than showing "connection failed".

```bash
npm run build:web     # bundle the renderer, copy her model and voice, generate pet.css
npm run web           # the same, then serve web/ on http://localhost:4173
```

Everything in `web/` except `index.html`, `docs.html`, `app.html`, `yui-boot.js`, `yui-page.js` and `yui-wallet.js` is generated —
including `downloads/`, which picks up the zip from `npm run package`. Upload the folder as-is.
The only thing to edit is the `YUI_CONFIG` block at the top of `index.html` (mint, download URL,
socials, relay host); until the mint is filled in the page says the contract is not published yet
rather than showing a placeholder that could be mistaken for a real address.

## The Chrome extension

`extension/` puts her on a trading terminal — Axiom, pump.fun, BullX, Photon, GMGN, Padre — as a
browser extension. It is the **same renderer again**, in a third container after Electron and a
plain tab: nothing in `src/renderer.js` or `web/yui-boot.js` was forked for it.

```bash
npm run build:ext            # extension/dist (load unpacked) + release/yui-extension-<version>.zip
npm run test:ext             # headless: loads the unpacked extension into Chromium and drives her
```

What the container does, and why:

| | |
| --- | --- |
| **a shadow root** | The site's stylesheet cannot restyle her panel (Tailwind resets every `button`), and hers cannot touch the site. The bundle is built with `document` pointed at a stand-in (`__YUI_DOC`) that answers `getElementById` and `body` from her shadow root, so the renderer never learned about it. |
| **chrome.storage** | One setup — wallet, look, size — that follows the trader to every site and survives the site clearing its own storage. `yui-boot.js` takes a storage object from `YUI_CONFIG`. |
| **the background worker** | Every terminal is https and an https page may only open `wss://`. Her socket is opened by the extension's service worker instead (`WebSocket` is pointed at `__YUI_WS`, a look-alike over a runtime port). One socket per relay URL is shared by every tab watching the same wallets, so a trader with six terminals open does not hit the relay's per-address cap; a tab joining late is handed the last `hello` so its positions are seeded too. The extension points at `wss://relay.tradingcompanion.fun` (Caddy terminates TLS on the relay box, live since 2026-09-24); if that name ever fails to resolve before the socket opens, the worker falls back to the plain address the app uses. |
| **a frame cap** | `requestAnimationFrame` is pointed at `__YUI_RAF`, which can hold her to 30 fps (the popup's switch) and stops her frames entirely while she is switched off for a site. |
| **the popup** | The wallet field, a per-site on/off switch, the frame cap, and what she is doing on the current tab. |

The site list lives at the top of `scripts/build-extension.js` (`SITES`); adding a terminal is one
line. Her right-click and double-click are only cancelled when they land on her, her panel or her
tour card — the site keeps its own context menu beside her.

Her logo lives in `branding/` — `yui-head.png` (backgroundless) is every icon, `yui-pfp.png` the
social preview; `python3 scripts/make-icons.py` regenerates `icon.png`, `yui.ico` and
`extension/icons/` from them. Before the store: add screenshots, a privacy policy URL, and check
the model's licence allows redistribution.

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
(default 113). A pair with no known dollar rate falls back to its own quote units.

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
