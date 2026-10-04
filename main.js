// Desktop pet — Electron main process.
// Creates a transparent, frameless, always-on-top, click-through window that
// covers the primary display's work area. The renderer decides (per frame)
// whether the cursor is over the character and toggles mouse pass-through.
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, dialog, nativeImage, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TEST = !!process.env.PET_TEST;
// the self-test must never touch the real settings.json
if (TEST) app.setPath('userData', path.join(require('os').tmpdir(), 'desktop-pet-test'));
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_MODEL = process.env.PET_MODEL || path.join(__dirname, 'models', 'shino.vrm');
// user sound files: <app>/sounds plus <userData>/sounds (the latter survives updates)
function soundDirs() { return [path.join(__dirname, 'sounds'), path.join(app.getPath('userData'), 'sounds')]; }
function listSoundFiles() {
  const out = [];
  for (const dir of soundDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) if (/\.(wav|mp3|ogg|m4a|flac)$/i.test(f)) out.push({ name: f, path: path.join(dir, f) });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let win = null;
let tray = null;
const DEFAULT_SOUNDS = {
  // her ElevenLabs voice pack (tools/voice-pack): the first line of each group; a slot left on its
  // default plays any line of that group. The free Sound Effect Lab clips (girl-*) stay selectable.
  profit: 'file:yui-profit-1.mp3', bigProfit: 'file:yui-bigProfit-1.mp3', loss: 'file:yui-loss-1.mp3', bigLoss: 'file:yui-bigLoss-1.mp3',
  buy: 'file:yui-buy-1.mp3', sell: 'file:yui-sellFlat-1.mp3', connect: 'file:yui-connect-1.mp3', click: 'file:yui-click-1.mp3', hover: 'file:yui-hover-1.mp3',
  grab: 'file:yui-grab-1.mp3', throw: 'file:yui-throw-1.mp3', land: 'file:yui-land-1.mp3', dizzy: 'file:yui-dizzy-1.mp3', jump: 'file:yui-jump-1.mp3', stretch: 'file:yui-stretch-1.mp3',
  cheerUp: 'file:yui-cheerUp-1.mp3',
};
// refreshed defaults for the trade slots (older saved settings still carry the synth names)
const TRADE_SLOT_DEFAULTS = { profit: DEFAULT_SOUNDS.profit, bigProfit: DEFAULT_SOUNDS.bigProfit, loss: DEFAULT_SOUNDS.loss, bigLoss: DEFAULT_SOUNDS.bigLoss, buy: DEFAULT_SOUNDS.buy, sell: DEFAULT_SOUNDS.sell, cheerUp: DEFAULT_SOUNDS.cheerUp };
// The public relay. It needs no token — a token inside a public download is not a secret, so it
// runs on caps instead (a few connections and a few wallets per address). Paste a wallet and she
// works; nothing else to set up.
//
// The hostname is preferred and the address is only a fallback, so that moving the relay to
// another box is a DNS change rather than a dead build for everyone who already downloaded her.
const PUBLIC_RELAY_HOST = 'relay.tradingcompanion.fun';
const PUBLIC_RELAY_PORT = 9998;
const PUBLIC_RELAY_FALLBACK = 'ws://192.248.179.126:9998';
let PUBLIC_RELAY = PUBLIC_RELAY_FALLBACK;
async function resolvePublicRelay() {
  try {
    await require('dns').promises.lookup(PUBLIC_RELAY_HOST);
    PUBLIC_RELAY = `ws://${PUBLIC_RELAY_HOST}:${PUBLIC_RELAY_PORT}`;
  } catch { /* no record yet: the address below still works */ }
  console.log('[pet] public relay', PUBLIC_RELAY);
}

// A relay.local.json next to main.js overrides all of that on your own machine. It is git-ignored
// and the packaging script leaves it out, so nothing private ever travels inside a release zip.
let DEFAULT_RELAY_URL = '', DEFAULT_RELAY_TOKEN = '';
try {
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay.local.json'), 'utf8'));
  if (typeof local.relayUrl === 'string') DEFAULT_RELAY_URL = local.relayUrl.trim();
  if (typeof local.relayToken === 'string') DEFAULT_RELAY_TOKEN = local.relayToken.trim();
} catch {}
// Everything she remembers lives in one object, written to settings.json a moment after it changes
// and read back on the next boot. "Reset everything" rebuilds it from here.
function defaultSettings() { return {
  model: null, sizePx: 640, alwaysOnTop: true, x: null,
  tourDone: false, userName: '',     // the first-run tour, and what she calls the user
  volume: 0.6, pitch: 1.0, muted: false,
  // Her figure. Mirrored by FIG in src/renderer.js — change both.
  bust: 0.36, jiggle: 1,             // bust size and how much it bounces (0..1)
  hips: 0.36, waist: 0, thighs: 0.6, headSize: 1,      // body proportions; 0.5 is the model as authored
  outfit: 'yui', cleavage: 0.4,  // outfit colour scheme and neckline depth (0..1)
  topStyle: 'full', bottomStyle: 'skirt', skirtLen: 0.3, bow: false,
  hairColor: '#3d1f73', eyeColor: '#a597f0',   // lookV3: the logo's colours   // '' = the model's own colour
  customVest: '#1a1a20', customSkirt: '#1a1a20', customBow: '#f2c73f',
  sign: true, signSize: 0.5, signStyle: 10, signHold: 'two', solPrice: 113, // the PnL sign she holds (10 = Aurora glass)
  wallets: '', relayUrl: '', relayToken: DEFAULT_RELAY_TOKEN, autoConnect: true,
  sounds: { ...DEFAULT_SOUNDS },
  // the companion: her "are you sure?" look, the sell nudge, where a coin opens, quiet mode, the screen she lives on
  guard: true, nudgePct: 50, nudgeMin: 30, openWith: 'axiom',
  quietBubbles: false, quietReactions: false, quietBoard: false, quietSounds: false, dndUntil: 0,
  display: null,                     // a display id from Electron's screen module; null = the primary
  lastGreetDay: '', stats: null, yesterday: null, totalTrades: 0, milestones: {},
}; }
let settings = defaultSettings();
let ignoring = null; // unknown until setIgnore() has been applied once (a transparent window is NOT click-through by default)

function loadSettings() {
  let raw = null;
  try { raw = fs.readFileSync(SETTINGS_PATH(), 'utf8'); } catch { return; } // no file yet: defaults
  try {
    const saved = JSON.parse(raw);
    const sounds = { ...DEFAULT_SOUNDS, ...(saved.sounds || {}) };
    // settings saved by the synth-only build: move the trade slots to the real clips once
    if (!saved.soundsV2) { Object.assign(sounds, TRADE_SLOT_DEFAULTS); saved.soundsV2 = true; }
    delete saved.name; // her name is fixed (Yui); drop any value saved by older builds
    // she holds the sign in both hands now; move existing settings over once
    if (!saved.signHoldV2) { saved.signHold = 'two'; saved.signHoldV2 = true; }
    // chalkboard at half size, held in both hands, is the look we settled on
    if (!saved.signLookV2) { saved.signSize = 0.5; saved.signStyle = 1; saved.signHold = 'two'; saved.signLookV2 = true; }
    // the board now matches her panel (Aurora glass); move existing settings over once
    if (!saved.signLookV3) { saved.signStyle = 10; saved.signLookV3 = true; }
    // her look was settled on 2026-09-14 (the figure, black hair, white eyes, Huge). A settings file
    // from an earlier build carries the model-as-authored look, so it moves to this one once.
    if (!saved.lookV2) {
      const d = defaultSettings();
      for (const k of ['bust', 'jiggle', 'cleavage', 'skirtLen', 'hips', 'waist', 'thighs', 'headSize', 'outfit', 'topStyle', 'bottomStyle', 'bow', 'hairColor', 'eyeColor', 'sizePx']) saved[k] = d[k];
      saved.lookV2 = true;
    }
    // 2026-09-24: her colours follow the logo (violet hair, lavender eyes, the violet outfit); once
    // 2026-09-24: the fallback SOL price moved 101.95 -> 113; an untouched old default follows it
    if (saved.solPrice === 101.95) saved.solPrice = 113;
    if (!saved.lookV3) {
      const d = defaultSettings();
      for (const k of ['outfit', 'hairColor', 'eyeColor']) saved[k] = d[k];
      saved.lookV3 = true;
    }
    Object.assign(settings, saved, { sounds });
    if (!settings.relayToken && DEFAULT_RELAY_TOKEN) settings.relayToken = DEFAULT_RELAY_TOKEN;
  } catch (e) {
    // keep the unreadable file instead of overwriting it on the next save: it is the only copy of
    // everything the user set up, and a truncated one is usually recoverable by hand
    try { fs.writeFileSync(SETTINGS_PATH() + '.bad', raw); } catch {}
    console.error('[pet] settings.json is unreadable (' + e.message + '); kept a copy as settings.json.bad');
  }
}
let saveTimer = null;
function writeSettingsNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const p = SETTINGS_PATH(), tmp = p + '.tmp';
  // write to a temporary file and rename over the real one: renaming is atomic, so a crash or a
  // power cut can leave the old settings or the new ones, never a half-written file
  try { fs.writeFileSync(tmp, JSON.stringify(settings, null, 2)); fs.renameSync(tmp, p); }
  catch { try { fs.unlinkSync(tmp); } catch {} }
}
// Dragging a slider sends an update every frame. Coalesce them: without this she rewrites the
// whole settings file sixty times a second for as long as the user holds the handle.
function saveSettings() { if (!saveTimer) saveTimer = setTimeout(writeSettingsNow, 400); }

// the display she lives on: the one chosen in her settings, or the primary
function herDisplay() {
  const all = screen.getAllDisplays();
  return (settings.display != null && all.find((d) => d.id === settings.display)) || screen.getPrimaryDisplay();
}
function workArea() { return herDisplay().workArea; }
function displaysList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({ id: d.id, primary: d.id === primary, label: `Screen ${i + 1} · ${d.size.width}×${d.size.height}${d.id === primary ? ' (main)' : ''}` }));
}
function placeOnDisplay() {
  if (!win) return;
  const wa = workArea();
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
}

function createWindow() {
  const wa = workArea();
  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#00000000',
    title: 'Desktop Pet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Chrome's window-occlusion tracker treats a full-screen window that is neither click-through nor
  // layered as opaque: the moment she is hovered or clicked (click-through off), every Chrome window
  // under her is marked hidden and its page (charts!) stops updating until the next focus change.
  // A layered window with alpha < 255 is always ignored by that tracker, so keep her at 99% opacity.
  win.setOpacity(0.99);
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // No menu bar — but the edit shortcuts (Ctrl+C / V / X / A) come from menu roles, and removing the
  // menu outright removed them too, so nothing could be pasted into the wallet field. Keep an
  // invisible menu that only carries the edit roles.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
  win.setMenuBarVisibility(false);
  setIgnore(true);
  console.log('[pet] build', buildStamp());
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => {
    sendSettings();
    sendModel(process.env.PET_MODEL || settings.model || DEFAULT_MODEL);
  });
  win.on('closed', () => { win = null; });

  // Cursor polling: works on every platform, even while the window is
  // click-through (Linux does not forward mouse events in that mode).
  let last = { x: -1, y: -1 };
  setInterval(() => {
    if (!win || TEST) return; // the self-test drives synthetic cursor positions; the real cursor must not override them
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const x = p.x - b.x, y = p.y - b.y;
    if (x !== last.x || y !== last.y) {
      last = { x, y };
      win.webContents.send('cursor', last);
    }
  }, 16);
}

function setIgnore(v) {
  if (!win) return;
  if (ignoring === v) return;
  ignoring = v;
  win.setIgnoreMouseEvents(v, { forward: true });
}

function buildStamp() {
  try {
    const d = fs.statSync(path.join(__dirname, 'dist', 'renderer.js')).mtime;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return 'unknown'; }
}
function sendSettings() {
  if (!win) return;
  win.webContents.send('settings', { ...settings, defaultSounds: DEFAULT_SOUNDS, soundFiles: listSoundFiles(), build: buildStamp(), displays: displaysList() });
}

let pendingModel = null; // persisted only once the renderer has parsed it (a broken file must not become the saved model)
function sendModel(file) {
  if (!win) return;
  try {
    const buf = fs.readFileSync(file);
    pendingModel = file;
    win.webContents.send('model', { name: path.basename(file), buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  } catch (e) {
    dialog.showErrorBox('Desktop Pet', `Could not load model:\n${file}\n${e.message}`);
    if (file !== DEFAULT_MODEL) sendModel(DEFAULT_MODEL);
  }
}

async function pickModel() {
  const r = await dialog.showOpenDialog({
    title: 'Choose a VRM model',
    filters: [{ name: 'VRM avatar', extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (!r.canceled && r.filePaths[0]) sendModel(r.filePaths[0]);
}

function buildMenu() {
  const size = (label, px) => ({
    label, type: 'radio', checked: settings.sizePx === px,
    click: () => { settings.sizePx = px; saveSettings(); sendSettings(); },
  });
  return Menu.buildFromTemplate([
    { label: 'Settings…', click: () => win && win.webContents.send('command', 'settings') },
    { label: 'Talk to Yui', click: () => win && win.webContents.send('command', 'talk') },
    { label: 'API keys…', click: () => win && win.webContents.send('command', 'keys') },
    { type: 'separator' },
    { label: 'Wave', click: () => win && win.webContents.send('command', 'wave') },
    { label: 'Sit down', click: () => win && win.webContents.send('command', 'sit') },
    { label: 'Stand up', click: () => win && win.webContents.send('command', 'stand') },
    { label: 'Walk around', click: () => win && win.webContents.send('command', 'walk') },
    { type: 'separator' },
    { label: 'Load VRM model…', click: pickModel },
    { label: 'Default model', click: () => sendModel(DEFAULT_MODEL) },
    { label: 'Size', submenu: [size('Small', 220), size('Medium', 320), size('Large', 460), size('Huge', 640)] },
    ...(screen.getAllDisplays().length > 1 ? [{ label: 'Screen', submenu: displaysList().map((d) => ({
      label: d.label, type: 'radio', checked: settings.display == null ? d.primary : settings.display === d.id,
      click: () => { settings.display = d.id; saveSettings(); placeOnDisplay(); sendSettings(); },
    })) }] : []),
    {
      label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop,
      click: (item) => {
        settings.alwaysOnTop = item.checked; saveSettings();
        if (win) win.setAlwaysOnTop(item.checked, 'screen-saver');
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Desktop Pet');
    tray.setContextMenu(buildMenu());
    tray.on('click', () => tray.popUpContextMenu(buildMenu()));
  } catch (e) {
    console.error('tray failed', e);
  }
}

ipcMain.on('set-ignore', (_e, v) => setIgnore(!!v));
ipcMain.on('context-menu', () => { if (win) buildMenu().popup({ window: win }); });
// right-click in a text field: the usual cut / copy / paste, since her own context menu covers everything else
ipcMain.on('edit-menu', () => { if (win) Menu.buildFromTemplate([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]).popup({ window: win }); });
ipcMain.on('save-state', (_e, s) => { if (s && typeof s.x === 'number') { settings.x = s.x; saveSettings(); } });
// partial settings update from the in-app settings panel
ipcMain.on('save-settings', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const sizeChanged = 'sizePx' in patch && patch.sizePx !== settings.sizePx;
  if ('sounds' in patch) patch.sounds = { ...settings.sounds, ...patch.sounds };
  Object.assign(settings, patch);
  saveSettings();
  if ('alwaysOnTop' in patch && win) win.setAlwaysOnTop(!!settings.alwaysOnTop, 'screen-saver');
  if (sizeChanged) sendSettings();
  if (tray && (sizeChanged || 'alwaysOnTop' in patch)) tray.setContextMenu(buildMenu()); // the only two settings it shows
});
ipcMain.on('pick-model', () => pickModel());
ipcMain.on('open-sounds-folder', () => {
  const dir = path.join(app.getPath('userData'), 'sounds');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  shell.openPath(dir);
});
ipcMain.on('rescan-sounds', () => sendSettings());
// a coin, in the browser. Only http(s) — this is the one place the renderer can ask the OS to open something.
ipcMain.on('open-external', (_e, url) => { if (typeof url === 'string' && /^https:\/\/(axiom\.trade|pump\.fun|dexscreener\.com|console\.anthropic\.com|elevenlabs\.io)\//.test(url)) shell.openExternal(url); });
ipcMain.on('set-display', (_e, id) => {
  if (!screen.getAllDisplays().some((d) => d.id === id)) return;
  settings.display = id; saveSettings(); placeOnDisplay(); sendSettings();
  if (tray) tray.setContextMenu(buildMenu());
});
ipcMain.on('default-model', () => sendModel(DEFAULT_MODEL));
ipcMain.on('model-ready', () => { if (pendingModel) { settings.model = pendingModel; pendingModel = null; saveSettings(); } });
ipcMain.on('model-failed', () => {
  const failed = pendingModel; pendingModel = null;
  if (failed && settings.model === failed) { settings.model = null; saveSettings(); }
  if (failed && failed !== DEFAULT_MODEL) sendModel(DEFAULT_MODEL);
});
ipcMain.on('log', (_e, m) => console.log('[pet]', m));
ipcMain.on('request-model', () => sendModel(settings.model || DEFAULT_MODEL));
ipcMain.on('quit', () => app.quit());
// talking to her (Claude + ElevenLabs with the user's own keys): src/desktop-chat.js, bundled
require('./dist/chat.js').init({ app, ipcMain, safeStorage, send: (m) => { if (win) win.webContents.send('chat-event', m); } });
// back to how she came: every setting, the name, the wallet; the bundled model; the tour again
ipcMain.on('reset-settings', () => {
  settings = defaultSettings();
  settings.relayUrl = DEFAULT_RELAY_URL || PUBLIC_RELAY;
  writeSettingsNow();
  sendSettings();
  if (tray) tray.setContextMenu(buildMenu());
  sendModel(DEFAULT_MODEL);
});

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  if (!TEST) loadSettings(); // the self-test screenshots every state from her defaults, not from whatever the last run saved
  await resolvePublicRelay();
  // Left alone, she points at the public relay. Anything typed into the panel, or a
  // relay.local.json, takes precedence and is never overwritten.
  if (!settings.relayUrl) settings.relayUrl = DEFAULT_RELAY_URL || PUBLIC_RELAY;
  if (TEST) { settings.x = null; settings.tourDone = true; }   // the tour has its own section in the self-test
  if (process.env.PET_PROBE) { settings.autoConnect = false; settings.lastGreetDay = '9999-99-99'; }   // a probe wants her still: no relay attempt, no greeting
  if (process.env.PET_TEST_RELAY) {
    // PET_TEST_RELAY = ws://host:port|token|wallet  -> the self-test also drives a relay round-trip
    const [u, t, w] = process.env.PET_TEST_RELAY.split('|');
    Object.assign(settings, { relayUrl: u, relayToken: t, wallets: w, autoConnect: true });
  }
  if (process.env.PET_SIZE) settings.sizePx = Number(process.env.PET_SIZE);
  createWindow();
  createTray();
  // screens come and go: keep her on hers, or fall back to the primary if it was unplugged
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => { placeOnDisplay(); sendSettings(); if (tray) tray.setContextMenu(buildMenu()); });
  if (TEST) { if (process.env.PET_PROBE) runProbe(); else runSelfTest(); }
});

app.on('before-quit', () => { if (saveTimer) writeSettingsNow(); });
app.on('window-all-closed', () => app.quit());

// ---- pose probe (PET_TEST=1 PET_PROBE='<js>|<seconds>'): run one expression, advance, screenshot, quit.
// For tuning a pose or a look by eye in ten seconds instead of a full self-test run.
async function runProbe() {
  const outDir = process.env.PET_TEST_OUT || __dirname;
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  try {
    await new Promise((r) => ipcMain.once('model-ready', r));
    await js('window.__petSyntheticOnly = true'); await js('window.__petAdvance(1.5)');
    const [code, secs] = process.env.PET_PROBE.split('|');
    await js(code); await js('window.__petAdvance(' + (Number(secs) || 1) + ')');
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(outDir, 'probe.png'), (await wc.capturePage()).toPNG());
    fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(await js('Object.assign(window.__petInfo(), { t: window.__pet.t, crouch: window.__pet.crouch, bob: window.__pet.bob, mood: window.__pet.mood, sign: window.__petSign() })')));
  } catch (e) { console.error('[probe]', e.message); }
  app.quit();
}

// ---- headless self-test (PET_TEST=1): deterministic screenshots of every state ----
async function runSelfTest() {
  const outDir = process.env.PET_TEST_OUT || __dirname;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  const adv = (sec) => js(`window.__petAdvance(${sec})`);
  const info = () => js('window.__petInfo()');
  const shot = async (name) => {
    await sleep(150); // let the compositor pick up the new frame
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    const i = await info();
    console.log(`[test] ${name.padEnd(18)} state=${i.state} x=${i.x.toFixed(2)} y=${i.y.toFixed(2)} theta=${i.theta.toFixed(2)}`);
    return i;
  };
  const mouseType = { mouseDown: 'mousedown', mouseUp: 'mouseup', mouseMove: 'mousemove' };
  const mouse = (type, x, y) => js(`window.__petMouse('${mouseType[type]}', ${Math.round(x)}, ${Math.round(y)})`);
  const results = [];
  const expect = (label, ok) => { results.push([label, ok]); console.log(`[test] ${ok ? 'PASS' : 'FAIL'} ${label}`); };
  try {
    await new Promise((r) => ipcMain.once('model-ready', r));
    await js('window.__petSyntheticOnly = true'); // the physical mouse must not steer the test
    await adv(1.5);
    const i0 = await shot('01-idle.png');
    expect('idle on ground', i0.state === 'idle' && i0.onGround);

    // ---- idle fidgets that move her: a hop on the spot, a shuffle to one side
    await js("window.__pet.micro = { name: 'hop', t: 0, dur: 1.15, side: 1 }"); await adv(0.49);
    await shot('01b-hop.png');
    expect('a hop lifts her off the ground for a beat', await js('window.__pet.bob / window.__petModel().height') > 0.03);
    await adv(1.2);
    expect('and she comes back down', await js('Math.abs(window.__pet.bob) / window.__petModel().height') < 0.005);
    const xs = (await info()).x;
    await js("window.__pet.micro = { name: 'shuffle', t: 0, dur: 2.4, side: 1 }"); await adv(2.6);
    const dxs = (await info()).x - xs;
    expect('a shuffle moves her half a step sideways', dxs > 0.05 && dxs < 0.3);

    // ---- drag: grab the chest, swing across the screen, hold
    setIgnore(false);
    const i1 = await info(); // she has just shuffled: grab where she is now, not where she was
    let x = i1.screenX, y = i1.screenY - i1.heightPx * 0.7;
    await mouse('mouseMove', x, y); await adv(0.05);
    await mouse('mouseDown', x, y); await adv(0.05);
    let ig = await info(); expect('grab starts', ig.state === 'grabbed');
    for (let i = 0; i < 40; i++) { x += 10; y -= 5; await mouse('mouseMove', x, y); await adv(1 / 60); }
    await shot('02-drag-swing.png');
    for (let i = 0; i < 60; i++) { await mouse('mouseMove', x, y); await adv(1 / 60); }
    const ih = await shot('03-drag-hold.png');
    expect('hangs upright while held still', Math.abs(ih.theta) < 0.25);
    // ---- throw: release while moving right
    for (let i = 0; i < 6; i++) { x += 30; await mouse('mouseMove', x, y); await adv(1 / 60); }
    await mouse('mouseUp', x, y); await adv(0.05);
    const it = await shot('04-thrown.png');
    expect('airborne after release', it.state === 'falling' && !it.onGround);
    await adv(1.2);
    const il = await shot('05-landed.png');
    expect('back on the ground', il.onGround && ['landing', 'idle', 'dizzy'].includes(il.state));
    await adv(2);
    const ii = await info(); expect('recovers to idle', ii.state === 'idle');
    expect('upright after landing', Math.abs(ii.theta) < 0.05);

    // ---- click -> wave
    x = ii.screenX; y = ii.screenY - ii.heightPx * 0.6;
    await mouse('mouseMove', x, y); await adv(0.05);
    await mouse('mouseDown', x, y); await adv(0.05); await mouse('mouseUp', x, y); await adv(0.6);
    const iw = await shot('06-wave.png');
    expect('click waves', iw.state === 'wave');
    expect('click opens her settings', await js("!document.getElementById('panel').hidden"));
    await js('window.__petPanel(false)'); await adv(0.2);
    await js('window.__petPanel(false)');
    await adv(2);

    // ---- double click -> jump
    await mouse('mouseDown', x, y); await adv(0.03); await mouse('mouseUp', x, y); await adv(0.1);
    await mouse('mouseDown', x, y); await adv(0.03); await mouse('mouseUp', x, y); await adv(0.25);
    const ij = await shot('07-jump.png');
    expect('double click jumps', !ij.onGround && ij.y > i0.y + 0.2);
    await adv(3);

    // ---- sit / walk via commands
    wc.send('command', 'sit'); await adv(2.5);
    const is = await shot('08-sit.png'); expect('sits', is.state === 'sit');
    wc.send('command', 'stand'); await adv(1.5);
    wc.send('command', 'walk'); await adv(1.2);
    const iwk = await shot('09-walk.png'); expect('walks', iwk.state === 'walk');
    await adv(6);
    const iw2 = await info(); expect('walk moves her', Math.abs(iw2.x - iwk.x) > 0.2 || iw2.state === 'idle');

    // ---- shake hard -> dizzy
    const ic = await info();
    x = ic.screenX; y = ic.screenY - ic.heightPx * 0.7;
    await mouse('mouseMove', x, y); await adv(0.05); await mouse('mouseDown', x, y); await adv(0.05);
    for (let i = 0; i < 90; i++) { x += (i % 6 < 3 ? 60 : -60); await mouse('mouseMove', x, y); await adv(1 / 60); }
    await shot('10-shaken.png');
    await mouse('mouseUp', x, y); await adv(0.05);
    await adv(1.5);
    const idz = await shot('11-dizzy.png'); expect('shaking makes her dizzy', idz.state === 'dizzy');
    await adv(4);
    expect('dizzy wears off', (await info()).state === 'idle');

    // ---- upside-down grab (by the foot) rights itself after release
    const iu = await info();
    x = iu.screenX + 8; y = iu.screenY - iu.heightPx * 0.08;
    await mouse('mouseMove', x, y); await adv(0.05); await mouse('mouseDown', x, y); await adv(0.05);
    const gb = await info();
    for (let i = 0; i < 90; i++) { y -= 4; await mouse('mouseMove', x, y); await adv(1 / 60); }
    for (let i = 0; i < 150; i++) { await mouse('mouseMove', x, y); await adv(1 / 60); }
    const iud = await shot('12-held-by-foot.png');
    expect('grabbed a leg/foot', /Leg|Foot/.test(gb.hit || ''));
    expect('hangs upside down by the foot', Math.abs(iud.theta) > 2.4);
    await mouse('mouseUp', x, y); await adv(3.5);
    const ir = await shot('13-righted.png');
    expect('rights herself after upside-down drop', ir.onGround && Math.abs(ir.theta) < 0.1);

    // ---- clicking her opens her settings ------------------------------------------------------
    await js('window.__petPanel(false)'); await adv(0.2);
    let ip = await info();
    const clickHer = async () => {
      // a click on her body, not a drag
      await mouse('mouseMove', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.05);
      await mouse('mouseDown', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.05);
      await mouse('mouseUp', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.5);
    };
    const panelBox = () => js("(()=>{const p=document.getElementById('panel'); if (p.hidden) return null; const r=p.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,tabs:p.querySelectorAll('.tabs button').length}})()");
    await clickHer();
    let pb = await panelBox();
    expect('clicking her opens her settings panel', !!pb && pb.tabs === 4);
    // beside her — never over her — and level with her body
    expect('the panel sits beside her, clear of her body',
      !!pb && (pb.left > ip.screenX + ip.heightPx * 0.18 || pb.right < ip.screenX - ip.heightPx * 0.18));
    expect('and is centred on her height',
      !!pb && Math.abs((pb.top + pb.bottom) / 2 - (ip.screenY - ip.heightPx * 0.5)) < ip.heightPx * 0.35);
    await sleep(500); // let it finish popping in, so the shot shows it at rest
    await shot('25-click-panel.png');
    await clickHer();
    expect('clicking her again puts it away', (await panelBox()) === null);

    // picking her up must put the settings away rather than drag them around the screen
    await clickHer();
    expect('a third click brings it back', (await panelBox()) !== null);
    await mouse('mouseMove', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.05);
    await mouse('mouseDown', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.08);
    expect('grabbing her closes the panel', await js("document.getElementById('panel').hidden === true"));
    for (let i = 0; i < 8; i++) { await mouse('mouseMove', ip.screenX + i * 12, ip.screenY - ip.heightPx * 0.7); await adv(1 / 60); }
    await mouse('mouseUp', ip.screenX + 96, ip.screenY - ip.heightPx * 0.7); await adv(2.5);

    // ---- the first-run tour -------------------------------------------------------------------
    await js('window.__petPanel(false)'); await adv(0.3);
    await js('window.__petTour.start()'); await adv(0.3);
    const tourSt = () => js('window.__petTour.state()');
    let ts = await tourSt();
    expect('the tour opens on the name step', ts.active && ts.visible && ts.step === 'name');
    const tcard = await js('window.__petTour.box()');
    ip = await info();
    expect('its card sits beside her, clear of her body', !!tcard && (tcard.left > ip.screenX + ip.heightPx * 0.18 || tcard.right < ip.screenX - ip.heightPx * 0.18));
    await js("window.__petTour.name('Alex')"); await adv(0.3);
    ts = await tourSt();
    expect('giving a name moves to the click step', ts.step === 'click' && settings.userName === 'Alex');
    expect('she uses the name straight away', /Alex/.test(await js('window.__petBubbleText()')));
    await sleep(500); await shot('26-tour.png');
    await clickHer(); await adv(0.6);
    ts = await tourSt();
    expect('clicking her completes the click step', ts.step === 'throw');
    await js('window.__petPanel(false)');
    // a throw: press, move, release while moving
    ip = await info();
    await mouse('mouseMove', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.05);
    await mouse('mouseDown', ip.screenX, ip.screenY - ip.heightPx * 0.7); await adv(0.1);
    for (let i = 1; i <= 10; i++) { await mouse('mouseMove', ip.screenX + i * 14, ip.screenY - ip.heightPx * 0.7 - i * 6); await adv(1 / 60); }
    await mouse('mouseUp', ip.screenX + 140, ip.screenY - ip.heightPx * 0.7 - 60); await adv(0.8);
    ts = await tourSt();
    expect('throwing her completes the throw step', ts.step === 'look');
    expect('the look step opens the Look tab and points at it', await js("!document.getElementById('panel').hidden && !!document.querySelector('#panel .tabs button.tour-hi[data-tab=look]')"));
    const apart = (a, b) => !!a && !!b && (a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    console.log('[test] tour box', JSON.stringify(await js('window.__petTour.box()')), 'panel box', JSON.stringify(await panelBox()), 'her', JSON.stringify(await info()));
    expect('the card and the panel do not overlap', apart(await js('window.__petTour.box()'), await panelBox()));
    // against the right edge the panel moves to her left; the card must still stay clear of it
    await js('window.__pet.x = window.__petBounds().max'); await adv(0.3);
    expect('nor at the screen edge', apart(await js('window.__petTour.box()'), await panelBox()));
    await js('window.__pet.x = 0'); await adv(0.3);
    await adv(2.5);
    expect('the look step waits: its button is locked until something is changed', await js("document.querySelector('#tour #tourNext').disabled === true"));
    await js('window.__petTour.next()'); await adv(0.3);
    expect('and pressing it locked does nothing', (await tourSt()).step === 'look');
    await js("document.querySelector('#panel #fBust').value = '0.6'; document.querySelector('#panel #fBust').dispatchEvent(new Event('input'))"); await adv(0.6);
    expect('changing her look unlocks the button but does not move on', (await tourSt()).step === 'look' && await js("document.querySelector('#tour #tourNext').disabled === false"));
    await js("document.querySelector('#panel #fBust').value = '0.36'; document.querySelector('#panel #fBust').dispatchEvent(new Event('input'))"); await adv(0.3);
    await js('window.__petTour.next()'); await adv(0.3);
    ts = await tourSt();
    expect('next moves to the wallet step', ts.step === 'wallet');
    await js('window.__petTour.skip()'); await adv(0.3);
    ts = await tourSt();
    expect('skipping the wallet skips the test buy too and shows the reactions', ts.step === 'reactions');
    await sleep(400); await shot('26b-tour-reactions.png');
    await js("document.querySelector('#tour [data-demo=profit]').click()"); await adv(0.45);
    let ir2 = await info();
    expect('the profit demo makes her cheer', ir2.state === 'cheer');
    expect('and she really jumps', await js('window.__pet.bob / window.__petModel().height') > 0.08);
    await adv(3);
    await js("document.querySelector('#tour [data-demo=loss]').click()"); await adv(1.0);
    ir2 = await info();
    expect('the loss demo makes her sad', ir2.state === 'comfort');
    await adv(4.5);
    await js('window.__petTour.next()'); await adv(0.3);
    ts = await tourSt();
    expect('next after the reactions reaches the end', ts.step === 'done');
    await js('window.__petTour.next()'); await adv(0.3);
    ts = await tourSt();
    expect('the tour closes and is remembered', !ts.active && !ts.visible && settings.tourDone === true && settings.userName === 'Alex');
    await js("window.__petReact({ side: 'sell', symbol: 'PEPE', quote: 'SOL', amount: 1.42, pnl: 0.61, pnlPct: 75 })"); await adv(0.4);
    expect('she calls the user by name on a win', /Alex/.test(await js('window.__petBubbleText()')));
    await adv(3);
    // reset: everything back to defaults, the tour again
    await js('window.__petReset()');
    await sleep(3000); await adv(0.5);   // the reset reloads the bundled model and restarts the tour on real-time timers
    ts = await tourSt();
    expect('reset clears the name and settings', settings.userName === '' && settings.tourDone === false && settings.bust === defaultSettings().bust);
    expect('and starts the tour over', ts.active && ts.step === 'name');
    await js("window.__petTour.name('Alex')"); await adv(0.2);   // leave the name in place for the rest of the run
    await js('window.__petTour.skip(); window.__petTour.skip()'); await adv(0.2);
    await js("document.querySelector('#panel #fBust').dispatchEvent(new Event('input'))"); await adv(0.6);
    await js('window.__petTour.next()'); await adv(0.3);
    ts = await tourSt();
    expect('the wallet step waits for the relay to say Live', ts.step === 'wallet');
    await js("window.__petRelayMsg({ type: 'hello', wallets: ['w'], positions: [], firehose: true })"); await adv(0.6);
    ts = await tourSt();
    expect('a Live relay completes the wallet step and asks for a test buy', ts.step === 'testbuy');
    await js("window.__petRelayMsg({ type: 'trade', side: 'buy', wallet: 'w', mint: 'TestBuyMint111111111111111111111111111111111', symbol: 'TEST', quote: 'SOL', amount: 0.05, tokens: 1000, remainingTokens: 1000, remainingCost: 0.05 })"); await adv(0.6);
    ts = await tourSt();
    expect('the first real trade completes the test buy', ts.step === 'reactions');
    await js('window.__petTour.next(); window.__petTour.next()'); await adv(0.3);
    ts = await tourSt();
    expect('the tour can be stepped through by button', !ts.active);
    await js("window.__petRelayMsg({ type: 'trade', side: 'sell', wallet: 'w', mint: 'TestBuyMint111111111111111111111111111111111', symbol: 'TEST', quote: 'SOL', amount: 0.05, tokens: 1000, pnl: null, pnlPct: null, remainingTokens: 0, remainingCost: 0 })"); await adv(1);
    // a replay while the wallet is already live: the wallet step passes on its own
    await js('window.__petTour.start()'); await adv(0.2);
    await js("window.__petTour.name('Alex')"); await adv(0.2);
    await js('window.__petTour.skip(); window.__petTour.skip()'); await adv(0.2);
    await js("document.querySelector('#panel #fBust').dispatchEvent(new Event('input'))"); await adv(0.6);
    await js('window.__petTour.next()'); await adv(2.2);
    ts = await tourSt();
    expect('a replay with the wallet live moves past the wallet step by itself', ts.step === 'testbuy');
    await js('window.__petTour.skip(); window.__petTour.next(); window.__petTour.next()'); await adv(0.3);
    expect('and finishes', !(await tourSt()).active);
    await js('window.__petPanel(false)'); await adv(6);   // let the reactions settle before the panel section
    await js('window.__petPanel(false)'); await adv(0.3);

    // ---- settings panel + trade reactions with speech bubble
    await js('window.__petPanel(true)'); await adv(0.3);
    await shot('14-panel.png');
    expect('settings panel renders', await js("!document.getElementById('panel').hidden && !!document.querySelector('#panel #fWallets') && !document.querySelector('#panel select[data-ev]')"));
    expect('the panel is tabbed and stays short', await js("(()=>{const p=document.getElementById('panel'); return p.querySelectorAll('.tabs button').length === 4 && p.getBoundingClientRect().height < 700})()"));
    expect('switching tabs keeps every control alive', await js("(()=>{const p=document.getElementById('panel'); [...p.querySelectorAll('.tabs button')].find(b=>b.dataset.tab==='look').click(); return !!p.querySelector('#fWallets') && !!p.querySelector('#fBust') && !!p.querySelector('#btnTestSign') && p.querySelector('[data-pg=look]').hidden === false})()"));
    await sleep(400); // the tab indicator slides; let it settle
    await shot('14b-panel-look.png');
    // with the panel open, only she and the panel catch the mouse; the rest of the desktop stays click-through
    await mouse('mouseMove', 20, 20); await adv(0.1);
    expect('panel open: empty desktop is click-through', ignoring === true);
    const pr = await js("(()=>{const r=document.getElementById('panel').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
    await mouse('mouseMove', pr.x, pr.y); await adv(0.1);
    expect('panel open: panel catches the mouse', ignoring === false);
    // paste into the wallet field: the edit roles must survive the hidden menu bar
    await js("[...document.querySelectorAll('#panel .tabs button')].find(b=>b.dataset.tab==='wallet').click()"); await adv(0.2);
    const { clipboard } = require('electron');
    clipboard.writeText('PasteTestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await js("document.querySelector('#panel #fWallets').focus(); document.querySelector('#panel #fWallets').value = ''");
    win.webContents.paste(); await sleep(300);
    expect('paste works in the wallet field', await js("document.querySelector('#panel #fWallets').value") === 'PasteTestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await js("document.querySelector('#panel #fWallets').value = ''");
    expect('she comes in Huge by default', defaultSettings().sizePx === 640);
    expect('she knows which screens there are', displaysList().length >= 1 && displaysList().some((d) => d.primary));
    await js('window.__petPanel(false)'); await adv(0.2);
    await js("window.__petReact({ side: 'sell', symbol: 'PEPE', quote: 'SOL', amount: 1.42, pnl: 0.61, pnlPct: 75 })"); await adv(0.7);
    const ic1 = await shot('15-profit.png'); expect('profit -> cheer', ic1.state === 'cheer');
    expect('profit makes her glow', await js('window.__pet.glow > 0.5'));
    expect('bubble shows', await js("document.getElementById('bubble').classList.contains('show')"));
    await adv(3.5);
    await js("window.__petReact({ side: 'sell', symbol: 'WOJAK', quote: 'SOL', amount: 0.31, pnl: -0.24, pnlPct: -44 })"); await adv(1.2);
    const ic2 = await shot('16-loss.png'); expect('loss -> comfort', ic2.state === 'comfort');
    expect('loss bruises her', await js('window.__pet.hurt > 0.3 && window.__pet.wounds.length > 0'));
    await adv(5);
    // two more big losses: every wound in the catalogue shows up
    await js("window.__petReact({ side: 'sell', symbol: 'RUG', quote: 'SOL', amount: 0.5, pnl: -1.6, pnlPct: -76 })"); await adv(5);
    await js("window.__petReact({ side: 'sell', symbol: 'RUG2', quote: 'SOL', amount: 0.5, pnl: -1.2, pnlPct: -70 })"); await adv(5.5);
    const ib = await shot('16b-bruised.png');
    expect('stacked losses -> fully bruised', ib.state === 'idle' && await js('window.__pet.hurt > 0.9 && window.__pet.wounds.length >= 8'));
    console.log('[test] wound anchors:', JSON.stringify(await js('window.__petWounds()')));
    const pm = await js('window.__petPaintMs()');
    console.log('[test] wound repaints:', JSON.stringify(pm));
    expect('painting a wound never stalls a frame (after the sheet is first built)', pm.n > 0 && pm.max < 30);
    // the painted skin sheets themselves, so a wound that lands in the wrong place can be seen
    const sheets = await js('window.__petWoundSheets()');
    for (const k in sheets) fs.writeFileSync(path.join(outDir, `26-skin-${k}.png`), Buffer.from(sheets[k].split(',')[1], 'base64'));
    await js("window.__petReact({ side: 'sell', symbol: 'MOON', quote: 'SOL', amount: 3, pnl: 2.4, pnlPct: 240 })"); await adv(0.8);
    await shot('16c-bigwin-glow.png');
    expect('big win heals her a bit', await js('window.__pet.hurt < 0.5 && window.__pet.glow > 0.9'));
    await adv(3);
    await js("window.__petReact({ side: 'buy', symbol: 'MOON', quote: 'SOL', amount: 0.5 })"); await adv(0.6);
    const ic3 = await shot('17-buy.png'); expect('buy -> notice', ic3.state === 'notice');
    await adv(3);
    expect('back to idle after reactions', (await info()).state === 'idle');

    // ---- the PnL sign: open a position, re-price it, go flat
    const M1 = 'TestMint1111111111111111111111111111111111';
    const M2 = 'TestMint2222222222222222222222222222222222';
    const relayMsg = (m) => js('window.__petRelayMsg(' + JSON.stringify(m) + ')');
    const signState = () => js('window.__petSign()');
    await relayMsg({ type: 'hello', wallets: ['W'], firehose: true, positions: [{ mint: 'OldBagMint1111111111111111111111111111111', tokens: 5e6, cost: 2, quote: 'SOL', symbol: 'OLDBAG' }] });
    await adv(2.2);
    // she must not raise a PnL board for a bag she was not watching when it opened
    const idle = await signState();
    expect('a bag open before connecting raises no board', !idle.content);
    expect('and with nothing to report she holds nothing', !idle.visible);
    expect('but the bag is still tracked for pnl', (await js('window.__petPositions()')).length === 1);
    await relayMsg({ type: 'trade', side: 'buy', mint: M1, symbol: 'PEPE', quote: 'SOL', amount: 1, tokens: 1e6, pnl: null, remainingTokens: 1e6, remainingCost: 1 });
    await adv(1.3);
    let sg = await signState();
    expect('buy -> she holds a sign for that token', sg.phase === 'held' && sg.visible && sg.content.title === '$PEPE');
    await shot('21-sign-position.png');
    await relayMsg({ type: 'price', mint: M1, price: 1.5e-6, quote: 'SOL', ts: Date.now() });
    await adv(0.5);
    sg = await signState();
    expect('a market trade re-prices the sign', sg.content.amount === '+0.500 SOL' && sg.content.sub === '+50.0%');
    expect('re-pricing does not re-pull the sign', sg.phase === 'held');
    await shot('22-sign-profit.png');
    await relayMsg({ type: 'trade', side: 'buy', mint: M2, symbol: 'WOJAK', quote: 'SOL', amount: 2, tokens: 4e6, pnl: null, remainingTokens: 4e6, remainingCost: 2 });
    await adv(0.3);
    // the swap waits until the board that is up has been readable for a moment
    expect('a newer token does not yank the board away immediately', (await signState()).phase === 'held');
    await adv(4.0);
    expect('and she swaps to the new one once the old one has been read', (await signState()).content.title === '$WOJAK');
    await relayMsg({ type: 'trade', side: 'sell', mint: M2, symbol: 'WOJAK', quote: 'SOL', amount: 2.6, tokens: 4e6, pnl: 0.6, pnlPct: 30, cost: 2, remainingTokens: 0, remainingCost: 0 });
    await adv(0.3);
    await relayMsg({ type: 'trade', side: 'sell', mint: M1, symbol: 'PEPE', quote: 'SOL', amount: 0.8, tokens: 1e6, pnl: -0.2, pnlPct: -20, cost: 1, remainingTokens: 0, remainingCost: 0 });
    await adv(2.4);
    sg = await signState();
    const sess = await js('window.__petSession()');
    expect('flat -> the sign shows the session total', sg.content.title === 'SESSION' && sg.content.amount === '+0.400 SOL');
    expect('session pnl sums the realised fills', Math.abs(sess.pnl - 0.4) < 1e-9 && sess.trades === 2);
    await shot('23-sign-session.png');
    // market cap drives the number: a stock-paired token's quote amount is not SOL, so a
    // price derived from it is meaningless. The cap ratio must still be right.
    const MC = 'McPairMint33333333333333333333333333333333';
    await relayMsg({ type: 'trade', side: 'buy', mint: MC, symbol: 'PAIRED', quote: 'SOL', amount: 1, tokens: 3e7, mcQuote: 30, pnl: null, remainingTokens: 3e7, remainingCost: 1 });
    await adv(1.6);
    await relayMsg({ type: 'price', mint: MC, price: 987654, quote: 'SOL', mcQuote: 60, ts: Date.now() });
    await adv(0.6);
    const mcc = (await signState()).content;
    const amt = Math.abs(Number(String(mcc.amount).replace(/[^0-9.]/g, '')) - 1) < 0.01;
    expect('a doubled market cap reads +100% despite a junk quote price', amt && /100/.test(mcc.sub));
    expect('the board shows the market cap in dollars', /^MC \$[\d.]/.test(mcc.foot || ''));
    await relayMsg({ type: 'trade', side: 'sell', mint: MC, symbol: 'PAIRED', quote: 'SOL', amount: 2, tokens: 3e7, mcQuote: 60, pnl: 1, pnlPct: 100, cost: 1, remainingTokens: 0, remainingCost: 0 });
    await adv(2.4);
    expect('and it returns to the session board', (await signState()).content.title === 'SESSION');
    for (const [label, frac] of [['left', 0.02], ['right', 0.98]]) {
      await js('(()=>{const b=window.__petBounds(); window.__pet.x = b.min + (b.max-b.min)*' + frac + ';})()');
      await adv(1.6);
      const box = await js('window.__petSignScreen()');
      expect('sign stays on screen at the ' + label + ' wall', !!box && box.l >= -1 && box.r <= box.W + 1);
    }
    await js('window.__pet.state = "falling"; window.__pet.onGround = false;');
    await adv(0.8);
    expect('thrown -> she puts the sign away', !(await signState()).visible);
    await js('window.__pet.onGround = true; window.__pet.state = "idle";');
    await adv(1.6);
    expect('landed -> the sign comes back', (await signState()).visible);
    const badge = await js('window.__petSignClose()');
    expect('the board has a close badge', !!badge && badge.r > 6);
    await js('window.__petSignHover(true)'); await adv(0.3);
    await js("window.__petMouse('mousedown', " + Math.round(badge.x) + ', ' + Math.round(badge.y) + ')');
    await adv(1.3);
    expect('clicking the X puts the board away', !(await signState()).visible);
    await relayMsg({ type: 'price', mint: M1, price: 1.9e-6, quote: 'SOL', ts: Date.now() });
    await adv(1.2);
    expect('a dismissed board does not come back on a price move', !(await signState()).visible);

    // ---- the Test position button: a demo board, no trading involved
    await js('window.__petPanel(true)');
    await adv(0.3);
    expect('the panel has a test-position button', await js("!!document.getElementById('btnTestSign')"));
    await js("document.getElementById('btnTestSign').click()");
    await js('window.__petPanel(false)');
    await adv(2.0);
    const dm = (await signState()).content;
    expect('the test button raises a demo board', !!dm && dm.id === 'demo' && /^\$[A-Z]+$/.test(dm.title));
    expect('the demo board is marked as one', /demo$/.test(dm.foot || ''));
    const before = dm.amount;
    await adv(2.6);
    expect('the demo value moves', (await signState()).content.amount !== before);
    const styles = await js('window.__petSignStyles()');
    expect('there are eleven board styles', styles.length === 11);
    for (let i = 0; i < styles.length; i++) { await js('window.__petSetStyle(' + i + ')'); await adv(0.5); }
    expect('every style renders without error', (await signState()).visible);
    // the default look, with a market cap line on it, at rest
    await js('window.__petSetStyle(10)'); await adv(0.6); await sleep(300);
    await shot('24b-board-aurora.png');
    await js('window.__petSetStyle(0)');
    await adv(0.6);

    // ---- the two-handed hold: board in front of her, a hand at each bottom corner
    // pin her facing the camera: a walk turns her body, which moves the hands sideways
    await js('window.__pet.state = "idle"; window.__pet.yaw = 0; window.__pet.yawTarget = 0; window.__pet.nextActionAt = 1e9;');
    await js('window.__petSignTwo(true)');
    await adv(2.2);
    const tb = await js('window.__petSignScreen()');
    const th = await js('window.__petHandsScreen()');
    const petX = await js('window.__petInfo().screenX');
    expect('two-handed: the board is centred on her', Math.abs((tb.l + tb.r) / 2 - petX) < (tb.r - tb.l) * 0.3);
    // a hand out at each side edge, not tucked underneath
    expect('two-handed: one hand at each side of the board', th.right.ax < -0.10 && th.left.ax > 0.10 && Math.abs(th.right.ax) < 0.24 && Math.abs(th.left.ax) < 0.24);
    expect('two-handed: she holds it above her waist', th.right.ay > 0.45 && th.right.ay < 0.75);
    // her hands must be in front of the board, or the fingers vanish behind it
    const signZ = await js('window.__petSignZ()');
    const modelH = await js('window.__petModel().height');
    expect('two-handed: her hands are in front of the board', th.right.wz / modelH > signZ && th.left.wz / modelH > signZ);
    // and the board must follow her grip even when she turns toward the cursor
    await js('window.__pet.yaw = 0.30;');
    await adv(1.0);
    const turned = await js('(()=>{const b=window.__petSignScreen(); const m=window.__petHandsPx(); return {bl:b.l,br:b.r,r:m.right.x,l:m.left.x}})()');
    expect('two-handed: her hands stay on the board when she turns',
      turned.r > turned.bl - 12 && turned.r < turned.br + 12 && turned.l > turned.bl - 12 && turned.l < turned.br + 12);
    await js('window.__pet.yaw = 0;');
    await adv(0.8);
    await shot('24-sign-two-handed.png');
    await js('window.__petSignTwo(false)');
    await adv(1.2);
    expect('back to a one-handed hold', (await signState()).visible);
    await js('window.__petDemoSign()');
    await adv(2.0);
    // starting a test clears any hand-dismissal, so ending it hands the board back: the session
    // total, for as long as it is still fresh
    const after = (await signState()).content;
    expect('turning the test off takes the demo board away', !after || after.id !== 'demo');

    // ---- buying repeatedly: she must not thrash between boards, and must keep the numbers right
    const rm = (n) => 'BurstMint' + n + 'x'.repeat(33);
    const burstBuy = (n) => relayMsg({ type: 'trade', side: 'buy', mint: rm(n), symbol: 'BRST' + n, quote: 'SOL',
      amount: 1, tokens: 1e6, mcQuote: 30, pnl: null, remainingTokens: 1e6, remainingCost: 1 });
    await adv(3.0);          // let whatever is on the board finish its minimum time first
    await burstBuy(1);
    await adv(1.6);          // just long enough for this one to finish coming out
    const firstId = (await signState()).id;
    expect('the first of a burst gets its own board', firstId === 'pos:' + rm(1));
    for (const n of [2, 3, 4]) { await burstBuy(n); await adv(0.25); }
    let bs = await signState();
    expect('a burst of buys never leaves her mid-swap', bs.phase === 'held');
    expect('the board that is up stays up until it can be read', bs.id === firstId);
    expect('every position is tracked', (await js('window.__petOpenCount()')) === 4);
    expect('the board says how many are open', /4 open/.test(bs.content.foot || ''));
    await relayMsg({ type: 'price', mint: rm(1), price: 1, quote: 'SOL', mcQuote: 45, ts: Date.now() });   // +50 %: re-priced, not yet a gasp
    await adv(0.3);
    expect('a waiting board still re-prices itself', /\+0\.500 SOL/.test((await signState()).text));
    await adv(3.2);
    expect('then it hands over to the newest position', (await signState()).id === 'pos:' + rm(4));
    // a relay reconnect resends open bags as history; she must not drop the board
    const openNow = await js('window.__petPositions()');
    await relayMsg({ type: 'hello', wallets: ['W'], firehose: true,
      positions: openNow.map((p) => ({ mint: p.mint, tokens: p.tokens, cost: p.cost, quote: 'SOL', symbol: p.symbol })) });
    await adv(2.0);
    expect('a reconnect does not make her drop the board', (await signState()).phase === 'held');
    expect('and those bags still count as live', (await js('window.__petOpenCount()')) === 4);
    for (const n of [1, 2, 3, 4]) {
      await relayMsg({ type: 'trade', side: 'sell', mint: rm(n), symbol: 'BRST' + n, quote: 'SOL',
        amount: 1.1, tokens: 1e6, mcQuote: 40, pnl: 0.1, pnlPct: 10, cost: 1, remainingTokens: 0, remainingCost: 0 });
      await adv(0.3);
    }
    await adv(3.0);
    expect('selling out clears every position', (await js('window.__petOpenCount()')) === 0 && (await js('window.__petLiveMints()')).length === 0);
    expect('and she falls back to the session board', (await signState()).content.id === 'session');
    // once the session total is no longer news, she puts the board away entirely
    await adv(26);
    expect('a stale session total is put away', (await signState()).content === null);

    // ---- alive: the market, the guard, the board's other faces, the day, quiet, sleep -----------
    const am = 'AliveMint' + 'a'.repeat(34);
    await relayMsg({ type: 'trade', side: 'buy', mint: am, symbol: 'ALIVE', quote: 'SOL', amount: 1, tokens: 1e6, mcQuote: 30, remainingTokens: 1e6, remainingCost: 1 }); await adv(2.5);
    await relayMsg({ type: 'price', mint: am, price: 2.1e-6, quote: 'SOL', mcQuote: 63, ts: Date.now() }); await adv(0.4);
    let ia = await info();
    expect('a coin she holds going 2x makes her gasp', ia.state === 'gasp');
    expect('and the board points at it', (await signState()).id === 'pos:' + am);
    expect('the badges: close, open, copy, flip', JSON.stringify((await js('window.__petBadges()')).sort()) === JSON.stringify(['close', 'copy', 'list', 'open']));
    await adv(3);
    await relayMsg({ type: 'price', mint: am, price: 5e-7, quote: 'SOL', mcQuote: 15, ts: Date.now() }); await adv(0.4);
    ia = await info();
    expect('and dumping makes her wince', ia.state === 'wince');
    await adv(3);
    // the flipped board: every open bag on one card
    const bm = 'AliveMint' + 'b'.repeat(34);
    await relayMsg({ type: 'trade', side: 'buy', mint: bm, symbol: 'BAGTWO', quote: 'SOL', amount: 0.5, tokens: 1e6, mcQuote: 30, remainingTokens: 1e6, remainingCost: 0.5 }); await adv(2.5);
    await js('window.__petBadgeClick("list")'); await adv(0.5);
    let lst = await signState();
    expect('the flip badge shows every open bag', !!lst.content && lst.content.id === 'list' && lst.content.lines.length === 2);
    expect('best bag first', !!lst.content && lst.content.lines[0].sym === '$BAGTWO' && lst.content.lines[1].sym === '$ALIVE');
    await sleep(300); await shot('27-list-board.png');
    await js('window.__petBadgeClick("list")'); await adv(0.5);
    expect('and flips back', (await signState()).content.id.startsWith('pos:'));
    // the "are you sure?" look: a loss, then the same coin bought straight back
    await relayMsg({ type: 'trade', side: 'sell', mint: bm, symbol: 'BAGTWO', quote: 'SOL', amount: 0.3, tokens: 1e6, mcQuote: 18, pnl: -0.2, pnlPct: -40, cost: 0.5, remainingTokens: 0, remainingCost: 0 }); await adv(5.5);
    await relayMsg({ type: 'trade', side: 'buy', mint: bm, symbol: 'BAGTWO', quote: 'SOL', amount: 0.3, tokens: 1e6, mcQuote: 18, remainingTokens: 1e6, remainingCost: 0.3 }); await adv(0.4);
    ia = await info();
    expect('buying back a coin just sold at a loss earns the look', ia.state === 'guard');
    expect('and she says so', /sure|again|Chasing/.test(await js('window.__petBubbleText()')));
    await sleep(300); await shot('28-guard.png');
    await adv(3.5);
    // the day's card and the numbers behind it
    const stats = await js('window.__petStats()');
    console.log('[test] day stats:', JSON.stringify(stats.stats));
    expect('the day keeps score', !!stats.stats && stats.stats.trades >= 5 && stats.stats.wins >= 4 && stats.stats.losses >= 1 && !!stats.stats.worst && stats.stats.worst.pnl <= -0.2 && !!stats.stats.best && stats.totalTrades > 0);
    await js('window.__petScorecard()'); await adv(2.5);
    const card = await signState();
    expect('the scorecard is a board of its own', !!card.content && card.content.id === 'day' && /trade/.test(card.content.sub) && /best/.test(card.content.foot || ''));
    await sleep(300); await shot('29-scorecard.png');
    // a milestone: confetti
    await js("window.__petCelebrate('Test!')"); await adv(0.3);
    expect('a celebration fires the confetti cannon', (await js('window.__petConfetti()')) > 30 && (await info()).state === 'cheer');
    await sleep(200); await shot('30-confetti.png');
    await adv(4);
    // do not disturb: the numbers move, she does not
    await js('window.__petSetCfg({ dndUntil: Date.now() + 60000 })'); await adv(0.2);
    const bubbleBefore = await js('window.__petBubbleText()');
    await js("window.__petReact({ side: 'sell', symbol: 'PEPE', quote: 'SOL', amount: 1.42, pnl: 0.61, pnlPct: 75 })"); await adv(0.4);
    expect('do not disturb keeps her still and silent', (await info()).state === 'idle' && (await js('window.__petBubbleText()')) === bubbleBefore && (await signState()).content === null);
    await js('window.__petSetCfg({ dndUntil: 0 })'); await adv(0.3);
    // twenty quiet minutes: she dozes off; a trade wakes her with a jolt
    await js('window.__petSleepNow()'); await adv(6);
    expect('left alone for twenty minutes she falls asleep', (await info()).state === 'sleep');
    await sleep(300); await shot('31-asleep.png');
    await js("window.__petReact({ side: 'buy', symbol: 'MOON', quote: 'SOL', amount: 0.5 })"); await adv(0.3);
    expect('a trade wakes her with a jolt', (await info()).state === 'wake');
    await adv(1.5);
    expect('and she is up again', (await info()).state !== 'sleep' && (await info()).state !== 'wake');
    expect('her mood carries the day', (await js('window.__petMood()')) > 0.3);
    await adv(2);

    if (process.env.PET_TEST_RELAY) {
      const [u, t, w] = process.env.PET_TEST_RELAY.split('|');
      const httpBase = u.replace(/^ws/, 'http').replace(/\/?$/, '');
      const post = (body) => new Promise((resolve, reject) => {
        const req = http.request(`${httpBase}/simulate?token=${encodeURIComponent(t)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
          let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d }));
        });
        req.on('error', reject); req.end(JSON.stringify(body));
      });
      await js('window.__petResume()');
      // wait (real time) for the pet to connect to the relay
      let st = null;
      for (let i = 0; i < 40 && !(st && st.relay === 'ok'); i++) { await sleep(250); st = await js('window.__petInfo()'); }
      expect('pet connects to relay', st && st.relay === 'ok');
      const mint = 'SimU1atedMint' + Math.random().toString(36).slice(2, 8).padEnd(31, 'x');
      let r = await post({ wallet: w, side: 'buy', mint, amount: 0.5, tokens: 1000000 });
      expect('relay accepts simulated buy', r.status === 200);
      await sleep(600); st = await js('window.__petInfo()');
      expect('buy over relay -> notice', st.state === 'notice');
      await shot('18-relay-buy.png');
      await sleep(2500);
      r = await post({ wallet: w, side: 'sell', mint, amount: 0.9, tokens: 1000000 });
      await sleep(600); st = await js('window.__petInfo()');
      expect('profitable sell over relay -> cheer', st.state === 'cheer');
      await shot('19-relay-profit.png');
      await sleep(3500);
      r = await post({ wallet: w, side: 'buy', mint, amount: 0.5, tokens: 1000000 }); await sleep(2500);
      r = await post({ wallet: w, side: 'sell', mint, amount: 0.2, tokens: 1000000 });
      await sleep(600); st = await js('window.__petInfo()');
      expect('losing sell over relay -> comfort', st.state === 'comfort');
      await shot('20-relay-loss.png');
      console.log('[test] sounds played:', JSON.stringify(await js('window.__petSounds')));
    }

    // ---- a relay is untrusted input ----------------------------------------------------------
    // Anyone running this points her at a relay box: their own, a friend's, or one that has since
    // changed. Malformed messages must not throw out of onmessage, and must never reach the totals.
    const badMsg = (o) => js('window.__petRelayMsg(' + JSON.stringify(o) + ')');
    await badMsg({ type: 'hello' });                                    // no wallets, no positions
    await badMsg({ type: 'hello', wallets: 'not-an-array', positions: 7 });
    await badMsg({ type: 'trade' });                                    // no mint at all
    await badMsg({ type: 'trade', side: 'sell', mint: 'BadM1nt', symbol: 'X'.repeat(4000),
                     quote: 'SOL', amount: 'oops', tokens: null, pnl: 'abc', pnlPct: {},
                     remainingTokens: 'x', mcQuote: 'NaN' });
    await badMsg({ type: 'price', mint: 'BadM1nt', mcQuote: 'NaN', price: 'x', quote: 'EUR' });
    await badMsg({ type: 'error', message: 42 });
    await adv(0.2);
    const badSess = await js('window.__petSession()');
    expect('malformed relay messages leave the session total a finite number',
      Number.isFinite(badSess.pnl) && Number.isFinite(badSess.trades));
    const bubbleLen = await js('document.getElementById("bubble").textContent.length');
    expect('an absurd token symbol cannot blow up the speech bubbleLen', bubbleLen < 300);
    const stillOk = await info();
    expect('still animating stillOk malformed relay messages', typeof stillOk.state === 'string' && Number.isFinite(stillOk.x));

    const failed = results.filter((r) => !r[1]).length;
    console.log(`[test] ${results.length - failed}/${results.length} checks passed`);
    if (failed) process.exitCode = 1;
  } catch (e) {
    console.error('[test] FAILED', e);
    process.exitCode = 1;
  }
  app.quit();
}
