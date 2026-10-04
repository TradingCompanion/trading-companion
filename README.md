# Yui — Trading Companion

<img width="1500" height="500" alt="image" src="https://github.com/user-attachments/assets/1c9cbe5b-0b81-40e9-8eae-afc5b093143f" />


**Yui is an AI agent.**

She is a mind, a voice and a body. The mind is **Claude Opus 5.5**: every answer she gives is
written on the spot, nothing is pre-recorded. The voice is **ElevenLabs v3**, generated live while
she answers, with real emotion in it — she giggles, gasps, whispers and sighs. The body is a 3D
anime girl who lives on your screen: she breathes, blinks, watches your cursor, walks around, and
can be picked up and thrown.

And she is a *trading* companion. Give her a public wallet address and she watches every pump.fun
trade you make, holds up your live PnL on a little board, glows gold when you win and turns up
bruised when you lose. Talk to her — by typing or out loud through your mic — and she answers you
like someone who was watching the same chart.

- **Website:** [tradingcompanion.fun](https://tradingcompanion.fun) — she is right there on the page; talk to her.
- **Desktop:** a Windows app; she stands on your taskbar over every window.
- **Read-only:** she only ever sees a public address. She never connects to a wallet, never signs, never needs a key to your funds.
- **Open source:** MIT. Everything she is, is in this repository.

---

## Contents

1. [What she is](#what-she-is)
2. [Talking to her](#talking-to-her)
3. [Where she runs](#where-she-runs)
4. [Quick start](#quick-start)
5. [Watching your trades](#watching-your-trades)
6. [What she does](#what-she-does)
7. [The PnL board](#the-pnl-board)
8. [Dressing her](#dressing-her)
9. [How it is built](#how-it-is-built)
10. [The chat, in detail](#the-chat-in-detail)
11. [The relay](#the-relay)
12. [The website](#the-website)
13. [Building a release](#building-a-release)
14. [Privacy and safety](#privacy-and-safety)
15. [Your own model](#your-own-model)
16. [Tests](#tests)

---

## What she is

Most "AI companions" are a chat box with a picture next to it. Yui is the other way around: a
character with a body and physics first, and an AI agent living inside it.

| Part | What it is | What it does |
| --- | --- | --- |
| **Mind** | Claude Opus 5.5 (Anthropic) | Understands what you say and writes her answer, in character, in your language. |
| **Voice** | ElevenLabs v3 | Reads the answer out loud as it is being written, with emotion tags (`[giggles]`, `[sighs]`, `[whispers]`…). Her lips follow the sound. |
| **Ears** | Speech recognition | Switch the mic on and just talk. She listens, answers, and listens again. |
| **Eyes** | The trade relay | Every buy and sell from the address you gave her reaches her within a second. |
| **Body** | A VRM avatar, Three.js | Procedural animation, drag-and-throw physics, spring-bone hair and skirt, expressions, wounds and glow. |

She knows what she is watching. When you talk to her she is told how many of your trades she has
seen this session and where your PnL stands, so "how am I doing?" gets a real answer.

She is honest about herself too: ask her sincerely what she is, and she will tell you she is Yui,
her words come from Claude and her voice from ElevenLabs.

## Talking to her

There is a chat bar at her feet.

- **Type** a line and press Enter.
- **Or press the mic** and speak. With the mic on it is a conversation: she hears you, thinks,
  answers out loud, then listens again. She does not listen while she is speaking, so she never
  hears herself.
- Her answer arrives **sentence by sentence**. The first sentence is spoken while the rest is
  still being written, so she starts talking in about two seconds.
- The words show in the speech bubble over her head while her voice says them.
- Say something new while she is still talking and she stops and takes the new line.

She keeps it short on purpose — one to three sentences, spoken words, no lists — because she is
talking, not writing.

What she will not do: tell you what to buy or sell, or ask for a private key or seed phrase. If
someone offers her one, she tells them never to share it.

## Where she runs

It is one character and one renderer in two containers. `src/renderer.js` is the whole of her
body and behaviour, and it talks to the outside through a single object, `window.pet`. Each
container supplies that object in its own way, so there is no second implementation to keep in
step.

| | Desktop app | Website |
| --- | --- | --- |
| Where she stands | your taskbar, over every window | the bottom of the page |
| Click-through | everywhere except her body | the page behind her stays usable |
| Settings | `settings.json` in your user profile | `localStorage`, per browser |
| Her mind and voice | your own API keys, kept on your PC | the site's keys, with per-visitor limits |
| Mic | recorded, transcribed by ElevenLabs | the browser's own speech recognition (ElevenLabs where the browser has none) |
| Trade feed | `ws://` to the relay | `wss://` through the site's proxy |
| Phone | — | yes: drag her with a finger |

## Quick start

### The website

Open [tradingcompanion.fun](https://tradingcompanion.fun). She walks over and says hello. Type in
the bar at the bottom or press the mic. Paste an address into her **Wallet** tab and she starts
watching it.

### The desktop app (Windows)

1. Download the zip from the website and unpack it anywhere. There is no installer.
2. Run `Yui.exe`. Windows will warn that the app is unsigned: **More info → Run anyway**.
3. She appears on your taskbar and walks you through a short tour.
4. She asks for your **API keys** (see below), and then she can talk.
5. Click her → **Wallet** → paste the address you trade from.

#### Her keys, on the desktop

The desktop app runs on **your own** keys. Nothing is shipped inside the download.

| Key | Needed? | What it gives her | Where to get it |
| --- | --- | --- | --- |
| **Claude API key** | yes, to talk | her mind | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **ElevenLabs API key** | optional | her voice, and your mic | [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) |

- With only a Claude key she answers in her speech bubble, silently.
- With both she speaks out loud and the mic button appears.
- Each key is checked when you paste it, so a typo is caught straight away.
- Keys are stored **only on your PC**, in the app's data folder, encrypted with Windows' own
  credential protection. They are sent to Anthropic and ElevenLabs and nowhere else.
- Change them any time: right-click her → **API keys…**
- Hide the chat bar with its **×**; right-click her → **Talk to Yui** brings it back.

Without any key she is still the full desktop companion — the body, the physics, the trade
reactions and the PnL board all work. The keys only add the conversation.

### From source

```bash
npm install
npm start
```

Windows, macOS and Linux (X11 with a compositor) run from source. The packaged release is Windows.

## Watching your trades

Click her → **Wallet**, paste one or more **public** addresses, press **Connect**. She ships
pointed at a public relay, so the address is the only thing to fill in — there is nothing to sign
up for.

From then on every buy and sell from that address on pump.fun reaches her within a second.

**What she can see:** bonding-curve trades on pump.fun. Once a token graduates and trades on
Raydium or PumpSwap, those fills are not in the feed she listens to, and she stays quiet on them.
The Wallet tab shows how many trades have actually arrived, so "connected but silent" is visible
rather than a guess.

**What she never sees:** your keys, your balance, anything that is not a public trade. She is
read-only by construction; there is no code path that signs or sends anything.

## What she does

### On her own

| You do | She does |
| --- | --- |
| nothing | breathes, shifts her weight, blinks, follows your cursor with her eyes and head, stretches, hums, wanders |
| hover over her | notices you and smiles |
| **drag her** | hangs from wherever you grabbed her and swings like a pendulum, legs kicking, hair and skirt flying. Grab a foot and she dangles upside-down |
| let go / throw her | flies with the cursor's velocity, flails, rights herself in the air, lands with a squash, bounces off the screen edges |
| shake her or throw her very hard | gets dizzy for a few seconds |
| click her | waves and opens her settings panel |
| double-click her | jumps |
| right-click her (desktop) | menu: settings, talk, API keys, wave, sit, walk, load another model, size, always on top, quit |
| ignore her for a few minutes | sits down and relaxes; longer, and she falls asleep |

### When you trade

| Event | She does |
| --- | --- |
| buy | perks up: "Ooh, $SYM! 0.5 SOL in. Good luck~" |
| sell at a profit | arms up, hops, a happy line: "+0.61 SOL on $PEPE~". Over 1 SOL or +100% gets the big-win reaction |
| sell at a loss | leans in, soft voice: "It's okay… only −0.24 SOL. Next one." |
| flat sell | "Clean exit~" |

**Wins make her glow**: a golden rim and halo, sparkles drifting up, fading over about fifteen
seconds.

**Losses leave a mark**: pale skin, a bruised cheek, a band-aid, a nosebleed. Big or repeated
losses add a cut brow, a black eye, a split lip and scrapes on her arm and knee. She heals over
a couple of minutes, and a profit patches her up faster.

Profit and loss are realised PnL against the average cost of what you sold, so partial exits are
handled correctly. Your cost basis is seeded from trade history when you connect, and a fill that
lands while that history is loading is matched against it so it is never counted twice.

She also keeps your day: streaks, milestones, a scorecard, a gentle nudge when you have been
holding a loser too long. **Quiet mode** silences any of bubbles, reactions, board or sounds, and
"do not disturb" silences all of them until a time you pick.

### Her recorded lines

Besides the live voice, she has a pack of 246 recorded lines in the same voice for moments that
should not wait for a round trip — the instant of a buy, being grabbed, landing, waking up. Each
event has a sound slot in her panel; you can assign your own clip to any of them.

## The PnL board

She keeps a stack of little signs behind her back. Open a position and she pulls one out and
holds it up:

```
 $PEPE
 +0.500 SOL
 +50.0%
```

- **Green in profit, red at a loss**, and **marked to market live**: the relay forwards a price
  tick whenever *anyone* trades a token you hold, so the number moves with the chart, not just
  with your own fills.
- The value comes from the **token's own market cap**, never from the raw quote amount of a
  trade. Not every pump.fun token is paired against SOL, so a per-trade price is not comparable
  across pairs; `current market cap / entry market cap` is correct whatever the pair is.
- **Several positions:** the board says how many are open. A board that is up earns a minimum
  time on screen before a newer position replaces it, so she is not flipping signs.
- **Flat:** she swaps to a **SESSION** board with your realised total.
- Only positions **opened while she is watching** raise a sign. Bags you already held are tracked
  for PnL but stay in her pocket.
- Hover the board and a **×** appears; click it and she puts the sign away. Only the × catches
  the mouse — clicks anywhere else on the board go through to the chart behind it.
- **Hold:** one hand (she grips the post) or both hands (she grips the board's edges). The board
  is fitted to where her hands actually are every frame, so it stays in her grip whatever she is
  doing.
- **Ten styles:** Neon glass, Chalkboard, Whiteboard, Terminal, Paper placard, Neon tube, Metal
  plate, LED matrix, Kawaii pastel, Holographic.
- **Test position** in her panel pulls out a demo board with a made-up ticker, so you can frame
  her on stream without opening a real trade.

## Dressing her

Click her → **Look**. Everything is applied live by recolouring and cutting the model's own
textures, so any VRM with VRoid-style material names works.

- Outfit colour schemes, or fully custom colours
- Top: full / sleeveless / crop / bikini — bottom: skirt / bikini
- Skirt length, neckline, ribbon on or off
- Hair and eye colour
- Figure sliders, including how much she bounces

Her panel has four tabs — **Her** (size, model, voice), **Look**, **Board**, **Wallet** — and it
follows her as she moves.

## How it is built

Electron, Three.js and [@pixiv/three-vrm](https://github.com/pixiv/three-vrm). No game engine, no
framework.

```
main.js                 Electron main process: the transparent window, tray, menu, settings
preload.js              the window.pet bridge for the desktop
index.html              the desktop window: four elements and the renderer bundle
src/
  renderer.js           HER: rendering, physics, states, panel, tour, trade reactions, the board
  yui-brain.js          her mind and voice: the Claude call, sentence cutting, ElevenLabs
  desktop-chat.js       the desktop's chat, in the main process, on the user's own keys
  voice.js, voice-pack.js   synthesised sounds and the table of her recorded lines
server/
  pet-relay.js          the trade relay: firehose in, per-wallet trades and prices out
  yui-chat.js           the website's chat: /api/yui/* on the site's own keys
web/
  index.html            the landing page
  app.html              the app in a tab, nothing around her
  docs.html             long-form documentation
  yui-boot.js           the browser version of window.pet
  yui-chat.js           the chat bar and mic (loaded by the desktop app too)
  yui-page.js           makes the page hers: first-visit hello, reactions to what you click
scripts/                builds, packaging, the static server
```

**The window (desktop).** One transparent, frameless, always-on-top window the size of the work
area. The main process polls the cursor and toggles click-through so the mouse passes to whatever
is underneath everywhere except her body, her panel and her chat bar.

**The body.** She is rendered with a perspective camera into a small canvas that follows her
around the screen, so each frame repaints only that region. The animation is procedural:
per-bone smoothed pose targets layered with breathing, sway and a walk cycle; a 2D rigid-body
simulation for the root (gravity, walls, floor, squash on impact); a driven pendulum for
dragging. Hair and skirt physics come from the VRM spring bones.

**One renderer.** `src/renderer.js` only ever talks to its container through `window.pet`:

| the desktop does this natively | the browser version |
| --- | --- |
| `setIgnore` — makes the window click-through | toggles `pointer-events` on her canvas |
| `onSettings` — `settings.json` | `localStorage` |
| `onModel` — the VRM over IPC | `fetch` with a progress bar |
| `saveState` — remembers where she stands | the same, in `localStorage` |
| `pickModel` — a native file dialog | a file input; the file never leaves your machine |

Her defaults are not written twice either: the web build reads `defaultSettings()` out of
`main.js`, so a change to how she ships in the zip is a change to how she loads in a tab.

## The chat, in detail

The same core (`src/yui-brain.js`) runs in both places; only who holds the keys differs.

```
you type or speak
      │
      ▼
 speech → text ──► Claude Opus 5.5 (streaming) ──► cut at sentence ends
                                                         │
                                  ┌──────────────────────┴───────────────┐
                                  ▼                                      ▼
                         ElevenLabs v3 (streaming)              speech bubble text
                                  │                              (emotion tags removed)
                                  ▼
                     played through the renderer:
                     her volume, her pitch, lip sync
```

- **Streaming end to end.** Claude's answer is cut into spoken pieces as it arrives: the first
  sentence goes alone so her voice starts early, then longer runs so the reading keeps one
  breath. Each piece is sent to ElevenLabs the moment its text is complete.
- **Emotion.** Claude may put ElevenLabs v3 audio tags in the text (`[giggles]`, `[sad]`,
  `[whispers]`). The voice performs them; the bubble strips them.
- **Lip sync.** The audio plays through the renderer (`window.__petSpeak`), which runs it through
  an analyser and drives her mouth shapes from the waveform.
- **Context.** Each request carries the last twenty turns of this conversation and two numbers
  from her session: how many of your trades she has seen, and your session PnL.
- **Memory.** The conversation lives only in the open tab or the running app. Nothing is stored.

**On the website** the browser never sees a key. `scripts/serve-web.js` hands `/api/yui/*` to
`server/yui-chat.js`:

| Route | |
| --- | --- |
| `POST /api/yui/chat` | the conversation in, an event stream of spoken pieces out |
| `GET /api/yui/audio/<id>` | the audio of one piece, streamed as it is produced, readable once |
| `POST /api/yui/stt` | recorded speech in, text out — for browsers with no speech recognition |
| `GET /api/yui/status` | whether chat and voice are set up |

The voice only ever reads what Claude wrote, so the site cannot be used as a free
text-to-speech endpoint. Because the site's keys are paid, each visitor has an allowance and the
voice has a daily budget; past it she keeps answering, in the bubble only:

| Setting (environment) | Default | |
| --- | --- | --- |
| `YUI_CHAT_PER_10MIN` | 40 | messages per visitor per ten minutes |
| `YUI_CHAT_PER_DAY` | 400 | messages per visitor per day |
| `YUI_VOICE_CHARS_DAY` | 12000 | characters of speech per day, all visitors together |
| `YUI_MODEL` | `claude-opus-5-5` | the model she thinks with |
| `YUI_VOICE`, `YUI_XI_MODEL` | her voice, `eleven_v3` | the ElevenLabs voice and model |

The server reads its keys from `.anthropic.key` and `.elevenlabs.key` at the repository root
(both git-ignored), or from `ANTHROPIC_API_KEY` / `ELEVENLABS_API_KEY`.

**In the desktop app** the same conversation runs in Electron's main process
(`src/desktop-chat.js`, bundled with the Anthropic SDK into `dist/chat.js`). The page asks over
IPC; the keys stay in the main process and are never handed back to the page. If the user's
ElevenLabs account cannot use her voice, she falls back to a stock ElevenLabs voice.

## The relay

She needs somewhere to get trade events from. `server/pet-relay.js` is a small WebSocket server
that sits next to a pump.fun trade firehose, keeps a per-wallet cost basis, and tells each
connected Yui about the trades of the addresses she watches — plus a throttled price tick for
every token those addresses hold.

**The public relay.** She ships pointed at `relay.tradingcompanion.fun`. It takes no token: a
token inside a public download is not a secret, so the relay runs on caps instead.

| Setting (`server/.env`) | Default | |
| --- | --- | --- |
| `PET_RELAY_PUBLIC` | — | `1` lets anyone connect without a token |
| `PET_MAX_SESSIONS` | 2000 | total sockets before new ones are refused |
| `PET_MAX_PER_IP` | 4 | connections from one address |
| `PET_MAX_WALLETS` | 3 | wallets an anonymous session may watch |
| `PET_MAX_WALLETS_AUTHED` | 40 | the same for a session that presents the token |
| `PET_SEED_CONCURRENCY` | 4 | history queries in flight; the rest queue |
| `PET_PRICE_MS` | 400 | throttle for price ticks on held tokens |

Matching is O(1) in the number of connected users: the signer and mint are pulled out of each
event and looked up in a set, rather than searching every event once per watched wallet.
`GET /health` reports the firehose and client state.

**Run your own.** The server is in the repository. Point `FIREHOSE_URL` at your own feed, set
`PET_RELAY_TOKEN`, and she is entirely yours:

```bash
cd server && npm install
node pet-relay.js
```

To prefill your own relay in a local build, put a `relay.local.json` next to `main.js`. It is
git-ignored and never packaged:

```json
{ "relayUrl": "wss://your-relay.example:9998", "relayToken": "…" }
```

## The website

`web/` holds three pages, and on all of them the Yui you see is the same renderer as the desktop
app.

- **`index.html`** — the landing page. A first visit opens on a short guided paper trade on a
  replayed real launch, so you see her react before you read a word; then she says hello and asks
  your name. After that the page is hers: buttons and sections make her speak, a click on the
  empty page walks her over, two quick clicks make her jump.
- **`app.html`** — the app in a tab: no page around her, the app's own defaults and tour.
- **`docs.html`** — long-form documentation.

Every visitor has their own Yui: settings live in that browser's `localStorage`, and each
connection to the relay carries its own wallets. Nothing is shared between visitors.

**An https page can only open `wss://`**, so the live site reaches the relay through a TLS proxy
at `wss://relay.tradingcompanion.fun`. A local preview over http talks to the relay directly.

```bash
npm run build:web     # bundle the renderer, copy her model and voice, generate the styles
npm run web           # the same, then serve web/ on http://localhost:4173
```

To serve it for real, run `scripts/serve-web.js` behind any TLS proxy (`PORT`, `HOST`, and
`INDEX=app.html` to make the app the front page). The page's own settings — mint, download link,
socials, relay — are the `YUI_CONFIG` block at the top of `index.html`.

In a tab the renderer picks a lighter profile: the display's own pixel density capped at 2×,
60 fps active and 30 calm, and her model is served pre-compressed.

## Building a release

```bash
npm run package        # leak scan → bundle → app folder → release/Yui-<version>-win-x64.zip
npm run package:check  # only the leak scan
```

The release is an unsigned zip of a self-contained folder: the Electron runtime with the app
under `resources/app`. It needs no installer and no admin rights.

**The leak scan is the point of the script.** Everything that ships is listed in `build.files`,
and the build **refuses to run** if any of those files contains a bare IP address, a websocket
URL, a wallet-shaped string or a credential that is not explicitly allowed in
`scripts/package-allow.txt`. The staged app folder is scanned again after it is assembled. API
keys are never in that list: they are files outside it, and git-ignored.

The zip can be cut on Windows or on Linux. Off Windows, unpack the official
`electron-v<version>-win32-x64.zip` into `release/electron-win32-x64` first; the icon and version
strings are stamped onto the exe in plain JavaScript.

`npm run build` alone produces everything the desktop app loads from `dist/`: the renderer
bundle, the chat's main-process half, and the chat bar.

## Privacy and safety

- **Read-only.** She receives a public address and public trades. No wallet connection, no
  signing, no private keys, ever.
- **Your address** is sent to the relay so it can match your trades. That is the only thing that
  leaves your machine for the trade feed.
- **What you say to her** goes to Anthropic (to write the answer) and ElevenLabs (to speak it,
  and to transcribe the mic where the browser cannot). On the website it passes through the
  site's server on the way; in the desktop app it goes straight from your PC with your own keys.
- **Nothing is stored.** The conversation exists only in the open tab or running app.
- **The mic** is used only while its button is on.
- **Your settings** stay local: `settings.json` under your user profile on the desktop,
  `localStorage` in the browser.
- **Your API keys** (desktop) are kept in the app's data folder, encrypted by the operating
  system, and are never written into the app folder or any release.

## Your own model

Right-click her → **Load VRM model…** and pick a `.vrm` file. VRM 0.x and 1.0 both work. Models
with spring bones (hair, skirts, ribbons) look best because those react to being dragged around.
Expressions use the standard VRM presets.

Bundled models:

| File | Author | Licence |
| --- | --- | --- |
| `models/shino.vrm` (default) — Sendagaya Shino | VRoid Project sample | CC0 |
| `models/three-vrm-girl.vrm` | pixiv Inc. | VRoid Hub licence, redistribution allowed, no credit required |
| `models/twist-sample.vrm` | pixiv Inc. | VRM Public License 1.0 |

## Tests

```bash
node server/test-relay.js   # the relay against a fake firehose: matching, fan-out, every limit (no database needed)
npm test                    # the desktop app, headless: every state driven with synthetic input
npm run test:web            # the same hooks against the app in a tab
npm run test:web:tour       # the first-run tour with real mouse and keyboard input
npm run test:web:page       # the landing page as an experience
```

The headless runs need Xvfb on Linux.

## Licence

MIT.
