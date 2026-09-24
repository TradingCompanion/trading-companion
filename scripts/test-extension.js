// Headless check of the Chrome extension: Electron's Chromium loads extension/dist unpacked (a
// dev build, so localhost is a matched site and the test bridge is compiled in), opens a page that
// stands in for a trading terminal — its own #panel and #bubble ids, a Tailwind-style reset, a
// chart that counts clicks — and drives her through the same moves the web self-test uses, plus
// the things only an extension has to get right: the site is untouched, clicks and right-clicks
// beside her reach the page, settings live in chrome.storage, and the relay socket is opened by
// the background worker.
//
//   npm run test:ext                       # builds the dev extension first
//   PET_TEST_OUT=/some/dir                 # where screenshots go (default: scripts/)
//   YUI_TEST_WALLET=<address>              # a real wallet to prove the relay round-trip; without
//                                          # it a placeholder address is used (the relay says hello)
'use strict';
const { app, BrowserWindow, session } = require('electron');
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'extension', 'dist');
const OUT = process.env.PET_TEST_OUT || __dirname;
const WALLET = process.env.YUI_TEST_WALLET || 'TestMint1111111111111111111111111111111111';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const PROFILE = path.join(require('os').tmpdir(), 'yui-ext-test');
fs.rmSync(PROFILE, { recursive: true, force: true });
app.setPath('userData', PROFILE);

// ---- a page that stands in for a terminal --------------------------------------------------------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>fake terminal</title>
<style>
  /* the resets a Tailwind site ships: these must not reach her */
  *, ::before, ::after { box-sizing: border-box; border: 0 solid #444; }
  button { background: transparent; background-image: none; color: inherit; font: inherit; padding: 0; text-transform: uppercase; }
  input { font: inherit; color: red; background: yellow; }
  canvas { display: inline; vertical-align: middle; border: 5px solid red; }
  html, body { margin: 0; background: #0b0e14; color: #dfe3ea; font: 14px/1.5 sans-serif; height: 100%; }
  #app { display: grid; grid-template-columns: 1fr 320px; height: 100%; }
  #chart { background: #121722; margin: 16px; border-radius: 8px; display: grid; place-items: center; user-select: text; }
  #panel { background: #1b2030; padding: 12px; }
  #bubble { color: #7c5cff; }
  #chart.hit { outline: 2px solid #34d5c9; }
</style></head><body>
<div id="app">
  <div id="chart">the chart · clicks <b id="clicks">0</b> · dblclicks <b id="dbl">0</b> · right-clicks <b id="rc">0</b> (blocked <b id="rcBlocked">0</b>)
    <p>${'some selectable text on the terminal. '.repeat(40)}</p></div>
  <div id="panel">site panel<div id="bubble">site bubble</div><button id="siteBtn">site button</button><input id="siteInput" value="site input"></div>
</div>
<script>
  var c = 0, d = 0, r = 0, rb = 0;
  document.getElementById('chart').addEventListener('click', function () { document.getElementById('clicks').textContent = ++c; });
  document.getElementById('chart').addEventListener('dblclick', function () { document.getElementById('dbl').textContent = ++d; });
  window.addEventListener('contextmenu', function (e) { document.getElementById('rc').textContent = ++r; if (e.defaultPrevented) document.getElementById('rcBlocked').textContent = ++rb; });
  window.counts = function () { return { clicks: c, dbl: d, rc: r, rcBlocked: rb }; };
  // the way into the extension's world (dev builds only): a string in, a string out
  window.yuiRpc = function (cmd, args) {
    return new Promise(function (res, rej) {
      var id = Math.random().toString(36).slice(2);
      var h = function (e) { var m; try { m = JSON.parse(e.detail); } catch (x) { return; } if (m.id !== id) return; document.removeEventListener('yui-test-result', h); m.ok ? res(m.value) : rej(new Error(m.value)); };
      document.addEventListener('yui-test-result', h);
      document.dispatchEvent(new CustomEvent('yui-test', { detail: JSON.stringify({ id: id, cmd: cmd, args: args }) }));
    });
  };
</script></body></html>`;

app.whenReady().then(async () => {
  console.log('[ext-test] building the dev extension…');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-extension.js'), '--dev'], { cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });

  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const URL_ = 'http://127.0.0.1:' + server.address().port + '/';

  const ext = await session.defaultSession.loadExtension(DIST, { allowFileAccess: true });
  console.log('[ext-test] loaded extension', ext.name, ext.version, ext.id);

  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  // The one honest witness of a cancelled right-click: Chromium asks for a native context menu only
  // when nothing on the page called preventDefault.
  let nativeMenus = 0;
  win.webContents.on('context-menu', () => { nativeMenus++; });
  win.webContents.on('console-message', (e, level, msg) => {
    if (/Electron Security Warning/.test(msg)) return;
    // Chromium's own GPU notices (software WebGL, ReadPixels stalls) on a box without a GPU: not hers.
    if (/GL Driver Message|swiftshader|GroupMarkerNotSet/i.test(msg)) return;
    if (level >= 2) pageErrors.push(msg);
    if (process.env.YUI_TEST_VERBOSE || level >= 2) console.log('[page]', msg);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const rpc = (cmd, ...args) => js('window.yuiRpc(' + JSON.stringify(cmd) + ', ' + JSON.stringify(args) + ')');
  const adv = (sec) => rpc('advance', sec);
  const info = () => rpc('info');
  const mouse = (type, x, y) => rpc('mouse', type, Math.round(x), Math.round(y));
  const sh = (sel, what) => rpc('shadow', sel, what);
  const results = [];
  const expect = (label, ok) => { results.push([label, ok]); console.log(`[ext-test] ${ok ? 'PASS' : 'FAIL'} ${label}`); };
  const shot = async (name) => {
    await sleep(150);
    fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
    const i = await info();
    console.log(`[ext-test] ${name.padEnd(20)} state=${i.state} x=${i.x.toFixed(2)} y=${i.y.toFixed(2)}`);
    return i;
  };
  const trusted = async (type, x, y, button) => { win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: button || 'left', clickCount: 1 }); await sleep(30); };

  try {
    await win.loadURL(URL_);
    const t0 = Date.now();
    while (!(await js("document.documentElement.classList.contains('yui-ready') || document.documentElement.classList.contains('yui-failed')"))) {
      if (Date.now() - t0 > 90000) throw new Error('she never loaded');
      await sleep(250);
    }
    expect('content script ran (dev bridge present)', await js("document.documentElement.dataset.yuiDev === '1'"));
    expect('model loaded', await js("document.documentElement.classList.contains('yui-ready')"));
    await rpc('synthetic');
    await adv(1.5);

    // ---- she lives in a shadow root; the site is untouched
    expect('one host element on the page', await js("document.querySelectorAll('yui-companion').length === 1"));
    expect('her canvases are inside the shadow root, none on the page body', await js("document.querySelector('yui-companion').shadowRoot.querySelectorAll('canvas').length >= 1 && document.querySelectorAll('body > canvas, #app canvas').length === 0"));
    expect("the site's own #panel and #bubble are untouched", await js("document.getElementById('panel').firstChild.textContent === 'site panel' && document.getElementById('bubble').textContent === 'site bubble'"));
    expect('the renderer found HER panel, not the site\'s', await rpc('proxyCheck'));
    expect("site stylesheet does not reach her canvas (no red border)", await js("getComputedStyle(document.querySelector('yui-companion').shadowRoot.querySelector('canvas')).borderTopWidth === '0px'"));
    expect('fonts registered in the page head', await js("!!document.getElementById('yui-doc-style') && document.fonts.check('500 14px Rubik')"));
    await shot('x01-loaded.png');

    // ---- settings: chrome.storage, not the site's localStorage
    await rpc('save', { userName: 'Ext' });
    await sleep(200);
    expect('a change lands in chrome.storage.local', JSON.parse(await rpc('storageGet', 'yui.web.settings.v2')).userName === 'Ext');
    expect("nothing written to the site's localStorage", await js("localStorage.getItem('yui.web.settings.v2') === null"));
    expect('extension defaults: her size fits a terminal, sound on, no token', await rpc('settings').then((s) => s.sizePx <= 640 && s.sizePx > 200 && s.muted === false && s.relayToken === ''));
    expect('relay defaults to the public relay', (await rpc('settings')).relayUrl === 'wss://relay.tradingcompanion.fun');

    // ---- the page beside her still works: trusted clicks, double clicks, right clicks
    const chart = await js("JSON.stringify(document.getElementById('chart').getBoundingClientRect())").then(JSON.parse);
    const cx = chart.left + 60, cy = chart.top + 40;
    expect('a point on the chart is the chart, not her host', await js(`document.elementFromPoint(${cx}, ${cy}).id === 'chart' || document.elementFromPoint(${cx}, ${cy}).closest('#chart') !== null`));
    await trusted('mouseDown', cx, cy); await trusted('mouseUp', cx, cy);
    await trusted('mouseDown', cx, cy, 'right'); await trusted('mouseUp', cx, cy, 'right');
    await sleep(100);
    const counts = await js('window.counts()');
    expect('a click on the chart reaches the page', counts.clicks === 1);
    expect('a right-click on the chart is not blocked by her (native menu asked for)', counts.rc === 1 && nativeMenus === 1);
    const i0 = await info();
    expect('idle on the ground', i0.onGround);
    // over her body her canvas takes the pointer; a right-click there is hers
    const hx = i0.screenX, hy = i0.screenY - i0.heightPx * 0.6;
    await mouse('mousemove', hx, hy); await adv(0.2);
    expect('a point on her body is her host', await js(`document.elementFromPoint(${hx}, ${hy}).tagName === 'YUI-COMPANION'`));
    await trusted('mouseDown', hx, hy, 'right'); await trusted('mouseUp', hx, hy, 'right'); await sleep(100);
    const c2 = await js('window.counts()');
    expect('a right-click on her is hers (no native menu)', c2.rc === 2 && nativeMenus === 1);

    // ---- grab, swing, throw, land
    let x = i0.screenX, y = i0.screenY - i0.heightPx * 0.7;
    await mouse('mousemove', x, y); await adv(0.05);
    await mouse('mousedown', x, y); await adv(0.05);
    expect('grab starts', (await info()).state === 'grabbed');
    expect('page marks the grab (no text selection while she is in hand)', await js("document.documentElement.classList.contains('yui-grabbing')"));
    for (let i = 0; i < 40; i++) { x += 10; y -= 5; await mouse('mousemove', x, y); await adv(1 / 60); }
    await shot('x02-drag.png');
    for (let i = 0; i < 6; i++) { x += 30; await mouse('mousemove', x, y); await adv(1 / 60); }
    await mouse('mouseup', x, y); await adv(0.05);
    expect('airborne after release', (await info()).state === 'falling');
    await adv(1.5);
    const il = await shot('x03-landed.png');
    expect('lands', il.onGround);
    await adv(2.5);

    // ---- click -> panel, inside the shadow root, and a click in its field stays in the panel
    const ii = await info();
    x = ii.screenX; y = ii.screenY - ii.heightPx * 0.6;
    await mouse('mousemove', x, y); await adv(0.05);
    await mouse('mousedown', x, y); await adv(0.05); await mouse('mouseup', x, y); await adv(0.6);
    expect('click opens her panel', !(await sh('#panel', 'hidden')));
    expect("panel is the app's (name, wallet, board fields)", (await sh('#fUserName', 'exists')) && (await sh('#fRelay', 'exists')) && (await sh('.pg[data-pg="wallet"]', 'exists')));
    expect('desktop-only controls hidden', !(await sh('#fTop', 'exists')) || (await sh('#fTop', 'webHidden')));
    expect('and the panel shows the saved name', (await sh('#fUserName', 'value')) === 'Ext');
    await shot('x04-panel.png');
    const nb = await sh('#fUserName', 'rect');
    const nx = nb.left + nb.width / 2, ny = nb.top + nb.height / 2;
    // A real press, not a synthetic one: the synthetic kind is dispatched on the window and has no
    // element under it. This is the case that needs composedPath — a press on an input in her panel
    // reaches the renderer's window listener retargeted to the host.
    await rpc('synthetic', false);
    await trusted('mouseMove', nx, ny); await adv(0.1);
    await trusted('mouseDown', nx, ny); await adv(0.05); await trusted('mouseUp', nx, ny); await adv(0.3);
    await rpc('synthetic', true);
    expect('a real press inside her panel does not close it (shadow target seen through)', !(await sh('#panel', 'hidden')));
    expect('the site button kept its site styling (no bleed out of the shadow)', await js("getComputedStyle(document.getElementById('siteBtn')).textTransform === 'uppercase' && getComputedStyle(document.getElementById('siteInput')).color === 'rgb(255, 0, 0)'"));

    // ---- the relay, through the background worker
    await rpc('connect'); await sleep(300);
    const r0 = await rpc('relay');
    expect('no wallet -> "enter a wallet address first"', /wallet address/i.test(r0.info));
    await rpc('setWallet', WALLET); await rpc('connect');
    const t1 = Date.now(); let r1;
    do { await sleep(300); r1 = await rpc('relay'); } while (!r1.connected && Date.now() - t1 < 20000);
    const pathUsed = await rpc('socketPath');
    expect('relay says hello (' + r1.status + ': ' + r1.info + ')', r1.connected);
    expect('the socket was opened by the background worker (path: ' + pathUsed + ')', pathUsed === 'background');
    expect('the popup\'s status call answers', await rpc('status').then((st) => st.wallet === WALLET && st.shown === true));
    await adv(1); await shot('x05-relay.png');

    // ---- the popup's per-site switch: off removes her and stops her frames; on brings her back
    await rpc('storageSet', { 'yui.ext': JSON.stringify({ off: { '127.0.0.1': true }, fps: 30 }) });
    await sleep(400);
    expect('switched off for this site: host removed', await js("document.querySelector('yui-companion') === null"));
    await sleep(100);
    const f0 = (await rpc('status')).frames; await sleep(500); const f1 = (await rpc('status')).frames;
    expect('and her frame loop is paused (' + f0 + ' -> ' + f1 + ')', f0 === f1);
    await rpc('storageSet', { 'yui.ext': JSON.stringify({ off: {}, fps: 30 }) });
    await sleep(400);
    expect('switched back on: host is back', await js("document.querySelector('yui-companion') !== null"));
    expect('frame cap applied from the popup', (await rpc('status')).fps === 30);
    await sleep(600);
    const f2 = (await rpc('status')).frames;
    expect('and her frames resume (' + f1 + ' -> ' + f2 + ')', f2 > f1);
    expect('she still answers after the round trip', (await info()).state !== undefined);

    expect('no page errors', pageErrors.length === 0);
  } catch (e) {
    console.error('[ext-test] crashed:', e);
    // what the page can see of her, for the post-mortem
    try {
      console.log('[ext-test] probe', JSON.stringify(await js(`(function () {
        var h = document.querySelector('yui-companion'); var sr = h && h.shadowRoot;
        return { host: !!h, canvases: sr ? sr.querySelectorAll('canvas').length : -1, loading: sr && sr.getElementById('loading') ? sr.getElementById('loading').textContent : null,
                 loadingHidden: sr && sr.getElementById('loading') ? sr.getElementById('loading').hidden : null, docStyle: !!document.getElementById('yui-doc-style'), dev: document.documentElement.dataset.yuiDev,
                 cls: document.documentElement.className };
      })()`)));
      console.log('[ext-test] probe2', JSON.stringify(await rpc('status')));
    } catch (e2) { console.log('[ext-test] probe failed', e2.message); }
    results.push(['no crash', false]);
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`[ext-test] ${results.length - failed.length}/${results.length} passed` + (pageErrors.length ? '\n[ext-test] page errors:\n  ' + pageErrors.join('\n  ') : ''));
  server.close();
  app.exit(failed.length ? 1 : 0);
});
