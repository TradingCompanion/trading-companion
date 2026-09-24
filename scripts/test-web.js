// Headless check of the app-in-a-tab build: opens the served page in Electron's Chromium (the
// same engine a visitor's browser runs), waits for her to load, then drives the identical hooks
// the desktop self-test drives — idle, grab, throw, land, click -> panel — plus the two things
// only the web build has to get right: the app's defaults reaching the page, and the relay
// answering a wallet over ws://.
//
//   npm run test:web                       # against http://127.0.0.1:8820/
//   YUI_WEB_URL=http://host:port/ npm run test:web
//   PET_TEST_OUT=/some/dir                 # where screenshots go (default: scripts/)
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PAGE = process.env.YUI_WEB_URL || 'http://127.0.0.1:8820/';
const OUT = process.env.PET_TEST_OUT || __dirname;
const WALLET = process.env.YUI_TEST_WALLET || '';   // a real address to prove the relay round-trip
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// a fresh profile every run: the first-run checks (tour, no wallet) must not see the last run's storage
const PROFILE = path.join(require('os').tmpdir(), 'yui-web-test');
fs.rmSync(PROFILE, { recursive: true, force: true });
app.setPath('userData', PROFILE);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (/Electron Security Warning/.test(msg)) return;   // Electron's own note about a page with no CSP; a browser has no such message
    if (level >= 2) pageErrors.push(msg);
    if (process.env.YUI_TEST_VERBOSE || level >= 2) console.log('[page]', msg);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const adv = (sec) => js(`window.__petAdvance(${sec})`);
  const info = () => js('window.__petInfo()');
  const results = [];
  const expect = (label, ok) => { results.push([label, ok]); console.log(`[web-test] ${ok ? 'PASS' : 'FAIL'} ${label}`); };
  const shot = async (name) => {
    await sleep(150);
    fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
    const i = await info();
    console.log(`[web-test] ${name.padEnd(20)} state=${i.state} x=${i.x.toFixed(2)} y=${i.y.toFixed(2)}`);
    return i;
  };
  const mouse = (type, x, y) => js(`window.__petMouse('${type}', ${Math.round(x)}, ${Math.round(y)})`);

  try {
    await win.loadURL(PAGE);
    // her body is a 14 MB fetch, then a GPU upload
    const t0 = Date.now();
    while (!(await js("document.documentElement.classList.contains('yui-ready') || document.documentElement.classList.contains('yui-failed')"))) {
      if (Date.now() - t0 > 90000) throw new Error('she never loaded');
      await sleep(250);
    }
    expect('model loaded', await js("document.documentElement.classList.contains('yui-ready')"));
    await js('window.__petSyntheticOnly = true');
    await adv(1.5);

    // ---- the app's defaults reached the page
    const s = await js('JSON.stringify(YuiWeb.settings)').then(JSON.parse);
    const d = await js('JSON.stringify(window.YUI_DEFAULTS)').then(JSON.parse);
    expect('defaults come from main.js (outfit, board, figure)', s.outfit === d.outfit && s.signStyle === d.signStyle && s.bust === d.bust && s.hips === d.hips);
    expect('sound on by default, like the app', s.muted === false);
    expect('size is the app\'s 640 on a monitor', s.sizePx === 640 && !s.userSized);
    expect('companion keys survive load (tour, nudge, quiet, stats)', 'tourDone' in s && 'nudgePct' in s && 'quietBoard' in s && 'stats' in s && 'milestones' in s);
    expect('no relay token in the bundle', s.relayToken === '' && d.relayToken === '');
    expect('relay URL follows the page host', s.relayUrl === 'ws://' + new URL(PAGE).hostname + ':9998');
    expect('all voice clips listed', Array.isArray(s.soundFiles) && s.soundFiles.length >= 40);
    expect('first-run tour appears', await js("!document.getElementById('tour').hidden"));
    await shot('w01-loaded.png');
    // The card's name field must be the thing under the cursor even after the renderer has made
    // her canvas clickable for that spot (it does so whenever the cursor is over the card).
    const nameBox = await js("JSON.stringify(document.getElementById('tourName').getBoundingClientRect())").then(JSON.parse);
    const nx = nameBox.left + nameBox.width / 2, ny = nameBox.top + nameBox.height / 2;
    await mouse('mousemove', nx, ny); await adv(0.2);
    expect('tour name field is clickable (not covered by her canvas)', await js(`document.elementFromPoint(${nx}, ${ny}).id === 'tourName'`));
    await js("window.__petTour.name('Alex')"); await adv(0.5);
    expect('typing a name moves the tour on and she is not grabbed', (await info()).state !== 'grabbed' && await js("window.__petTour.state().step !== 'name'"));
    expect('the name is hers now', await js("YuiWeb.settings.userName === 'Alex'"));

    // ---- a second visit: what was saved comes back, and the tour does not
    await js('YuiWeb.save({ tourDone: true })');
    await win.loadURL(PAGE);
    const t1 = Date.now();
    while (!(await js("document.documentElement.classList.contains('yui-ready')"))) {
      if (Date.now() - t1 > 90000) throw new Error('she never loaded the second time');
      await sleep(250);
    }
    await js('window.__petSyntheticOnly = true');
    await adv(1.5);
    expect('settings survive a reload (name, tour done)', await js("YuiWeb.settings.userName === 'Alex' && YuiWeb.settings.tourDone === true"));
    expect('no tour on the second visit', await js("document.getElementById('tour').hidden"));
    const i0 = await info();
    expect('idle on the ground', i0.onGround);

    // ---- grab, swing, throw, land — the app's self-test moves, on the web page
    let x = i0.screenX, y = i0.screenY - i0.heightPx * 0.7;
    await mouse('mousemove', x, y); await adv(0.05);
    await mouse('mousedown', x, y); await adv(0.05);
    expect('grab starts', (await info()).state === 'grabbed');
    expect('page marks the grab (no text selection while she is in hand)', await js("document.documentElement.classList.contains('yui-grabbing')"));
    for (let i = 0; i < 40; i++) { x += 10; y -= 5; await mouse('mousemove', x, y); await adv(1 / 60); }
    await shot('w02-drag.png');
    for (let i = 0; i < 6; i++) { x += 30; await mouse('mousemove', x, y); await adv(1 / 60); }
    await mouse('mouseup', x, y); await adv(0.05);
    expect('airborne after release', (await info()).state === 'falling');
    await adv(1.5);
    const il = await shot('w03-landed.png');
    expect('lands', il.onGround);
    await adv(2.5);

    // ---- click -> wave + panel, and the panel is the app's
    const ii = await info();
    x = ii.screenX; y = ii.screenY - ii.heightPx * 0.6;
    await mouse('mousemove', x, y); await adv(0.05);
    await mouse('mousedown', x, y); await adv(0.05); await mouse('mouseup', x, y); await adv(0.6);
    expect('click opens her panel', await js("!document.getElementById('panel').hidden"));
    expect('panel shows the app\'s controls (name, wallet, board)', await js("!!(document.getElementById('fUserName') && document.getElementById('fRelay') && document.querySelector('.pg[data-pg=\"wallet\"]'))"));
    expect('desktop-only controls hidden', await js("(function(){var t=document.getElementById('fTop');return !t || !!t.closest('.web-hide');})()"));
    await shot('w04-panel.png');

    // ---- settings persist per browser
    await js("YuiWeb.save({ userName: 'Test' })");
    expect('a change is written to localStorage', await js("JSON.parse(localStorage.getItem('yui.web.settings.v2')).userName === 'Test'"));
    expect('and the panel shows it', await js("document.getElementById('fUserName').value === 'Test'"));

    // ---- the relay: a wallet-less connect says what the app says; a wallet gets a hello
    await js('YuiWeb.connect()'); await sleep(300);
    const r0 = await js('JSON.stringify(YuiWeb.relay())').then(JSON.parse);
    expect('no wallet -> "enter a wallet address first"', /wallet address/i.test(r0.info));
    if (WALLET) {
      await js(`YuiWeb.setWallet(${JSON.stringify(WALLET)}); YuiWeb.connect()`);
      const t1 = Date.now(); let r1;
      do { await sleep(300); r1 = await js('JSON.stringify(YuiWeb.relay())').then(JSON.parse); } while (!r1.connected && Date.now() - t1 < 15000);
      expect('relay says hello for a real wallet (' + r1.status + ': ' + r1.info + ')', r1.connected);
      await adv(1); await shot('w05-relay.png');
    } else console.log('[web-test] (set YUI_TEST_WALLET=<address> to also prove the relay round-trip)');

    expect('no page errors', pageErrors.length === 0);
  } catch (e) {
    console.error('[web-test] crashed:', e);
    results.push(['no crash', false]);
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`[web-test] ${results.length - failed.length}/${results.length} passed` + (pageErrors.length ? '\n[web-test] page errors:\n  ' + pageErrors.join('\n  ') : ''));
  app.exit(failed.length ? 1 : 0);
});
