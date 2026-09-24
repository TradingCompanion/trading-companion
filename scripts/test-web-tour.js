// The first-run tour, walked end to end with real input.
//
// test-web.js drives her through the synthetic hooks and fixed time steps, which is right for
// physics and wrong for a question like "can a person click this button": the hooks dispatch on
// the window and never touch DOM hit-testing. This one sends trusted mouse and keyboard events
// through Chromium (webContents.sendInputEvent) and waits on what a person would wait on — the
// panel opening, the tour moving — so it fails exactly where a visitor would get stuck.
//
//   npm run test:web:tour
//   YUI_TEST_WALLET=<address> npm run test:web:tour     # also the wallet step, for real
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PAGE = process.env.YUI_WEB_URL || 'http://127.0.0.1:8820/';
const OUT = process.env.PET_TEST_OUT || __dirname;
const WALLET = process.env.YUI_TEST_WALLET || '';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const PROFILE = path.join(require('os').tmpdir(), 'yui-web-tour-test');
fs.rmSync(PROFILE, { recursive: true, force: true });
app.setPath('userData', PROFILE);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const pageErrors = [];
  wc.on('console-message', (e, level, msg) => {
    if (/Electron Security Warning/.test(msg)) return;
    if (/GL_INVALID_OPERATION: Level of detail/.test(msg)) return;   // SwiftShader on her bruise textures; not seen on a GPU
    if (level >= 2) pageErrors.push(msg);
    if (process.env.YUI_TEST_VERBOSE || level >= 2) console.log('[page]', msg);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code);
  const results = [];
  const expect = (label, ok) => { results.push([label, ok]); console.log(`[tour-test] ${ok ? 'PASS' : 'FAIL'} ${label}`); return ok; };
  const shot = async (name) => { await sleep(150); fs.writeFileSync(path.join(OUT, name), (await wc.capturePage()).toPNG()); };
  // Software rendering makes her frames slow, so nothing here sleeps a fixed time and hopes; it
  // asks the page until the answer is yes or the patience runs out.
  const until = async (cond, ms, every) => {
    const t0 = Date.now();
    for (;;) {
      if (await js(cond)) return true;
      if (Date.now() - t0 > (ms || 15000)) return false;
      await sleep(every || 200);
    }
  };
  const step = () => js('window.__petTour.state().step');
  const untilStep = (k, ms) => until(`window.__petTour.state().step === ${JSON.stringify(k)}`, ms);

  // ---- real input ------------------------------------------------------------------------------
  const move = async (x, y) => { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await sleep(60); };
  const down = async (x, y) => { wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }); await sleep(60); };
  const up = async (x, y) => { wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }); await sleep(60); };
  const key = async (k) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'char', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(60); };
  const rect = async (sel) => js(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()`);
  // what a press at (x, y) would land on, as TAG#id — the honest test of "can this be clicked"
  const under = (x, y) => js(`(function(){var e=document.elementFromPoint(${Math.round(x)},${Math.round(y)});return e?(e.tagName+(e.id?'#'+e.id:'')):'none'})()`);
  // click a DOM control the way a person does: hover first, then press and release on it
  const clickEl = async (sel) => {
    const r = await rect(sel);
    if (!r) { console.log('[tour-test] no element ' + sel); return false; }
    await move(r.x, r.y); await sleep(150);
    const hit = await under(r.x, r.y);
    await down(r.x, r.y); await up(r.x, r.y);
    return hit;
  };
  // click her: the renderer has to see the cursor over her first (one frame), then it takes the press
  const her = async (frac) => { const i = await js('window.__petInfo()'); return { x: i.screenX, y: i.screenY - i.heightPx * frac }; };
  const hoverHer = async (frac) => {
    const p = await her(frac);
    await move(p.x, p.y);
    const ok = await until('!!window.__petInfo().hit', 8000, 150);
    return { ...p, ok };
  };
  const clickHer = async (frac) => {
    const p = await hoverHer(frac);
    if (!p.ok) return false;
    await down(p.x, p.y); await sleep(80); await up(p.x, p.y);
    return true;
  };

  try {
    await win.loadURL(PAGE);
    expect('she loads', await until("document.documentElement.classList.contains('yui-ready')", 90000, 300));
    // the front page opens on the starter (the guided paper trade, covered by test-web-page.js);
    // the hello comes after it
    if (await js('!!window.YuiStarter')) { await until('YuiStarter.step() >= 1', 90000, 300); await js('YuiStarter.end()'); }
    expect('the tour opens on its own', await untilStep('name', 15000));
    await shot('t01-name.png');

    // ---- name: click the field, type, Enter ------------------------------------------------------
    const hitName = await clickEl('#tourName');
    expect('the name field takes the click (' + hitName + ')', hitName === 'INPUT#tourName');
    expect('and has focus', await js("document.activeElement && document.activeElement.id === 'tourName'"));
    await wc.insertText('Alex');
    expect('typing lands in it', await js("document.getElementById('tourName').value === 'Alex'"));
    await key('Enter');
    expect('Enter moves on to "click me"', await untilStep('click', 5000));
    expect('she was not grabbed by any of that', await js("window.__petInfo().state !== 'grabbed'"));
    expect('her name is saved', await js("YuiWeb.settings.userName === 'Alex'"));

    // ---- click me once ------------------------------------------------------------------------
    expect('clicking her opens the panel', await clickHer(0.6) && await until("!document.getElementById('panel').hidden", 8000));
    expect('the tour moves on to "pick me up"', await untilStep('throw', 8000));
    expect('and puts the panel away for the throw', await until("document.getElementById('panel').hidden", 8000));

    // ---- pick me up ---------------------------------------------------------------------------
    const g = await hoverHer(0.7);
    expect('cursor over her reads as her', g.ok);
    await down(g.x, g.y);
    expect('press starts a grab', await until("window.__petInfo().state === 'grabbed'", 8000, 100));
    let x = g.x, y = g.y;
    for (let i = 0; i < 25; i++) { x += 14; y -= 6; await move(x, y); }
    await shot('t02-drag.png');
    for (let i = 0; i < 6; i++) { x += 30; await move(x, y); }
    await up(x, y);
    expect('release counts as a throw: "dress me up" is next', await untilStep('look', 8000));
    expect('the panel opens on the Look tab', await until("!document.getElementById('panel').hidden && document.querySelector('#panel .tabs button.on').dataset.tab === 'look'", 8000));
    await until("window.__petInfo().onGround && window.__petInfo().state === 'idle'", 15000, 200);

    // ---- dress me up --------------------------------------------------------------------------
    expect('"Done dressing" is enabled before any change', await js("(function(){var b=document.getElementById('tourNext');return !!b && !b.disabled})()"));
    // a press on the empty page must not close the panel (on the desktop it never reaches her)
    await move(60, 60); await sleep(150); await down(60, 60); await up(60, 60); await sleep(300);
    expect('a click on the empty page leaves the panel open', await js("!document.getElementById('panel').hidden"));
    expect('and the tour still on "dress me up"', (await step()) === 'look');
    // change something for real: a slider inside the panel
    const sl = await rect('#fBust');
    const slHit = await under(sl.x + sl.w * 0.35, sl.y);
    expect('the panel slider is what the cursor finds (' + slHit + ')', slHit === 'INPUT#fBust');
    await move(sl.x + sl.w * 0.35, sl.y); await down(sl.x + sl.w * 0.35, sl.y); await move(sl.x + sl.w * 0.45, sl.y); await up(sl.x + sl.w * 0.45, sl.y);
    expect('dragging the slider changes her', await until("Math.abs(YuiWeb.settings.bust - window.YUI_DEFAULTS.bust) > 0.02", 5000));
    const hitDone = await clickEl('#tourNext');
    expect('"Done dressing" takes the click (' + hitDone + ')', hitDone === 'BUTTON#tourNext');
    expect('and the tour moves to the wallet', await untilStep('wallet', 5000));
    expect('the panel is on the Wallet tab', await until("document.querySelector('#panel .tabs button.on').dataset.tab === 'wallet'", 5000));
    await shot('t03-wallet.png');

    // ---- connect your wallet ------------------------------------------------------------------
    if (WALLET) {
      const hitW = await clickEl('#fWallets');
      expect('the wallet field takes the click (' + hitW + ')', hitW === 'INPUT#fWallets');
      await wc.insertText(WALLET);
      const hitC = await clickEl('#btnConnect');
      expect('Connect takes the click (' + hitC + ')', hitC === 'BUTTON#btnConnect');
      expect('the relay goes Live', await until("window.__petInfo().relay === 'ok'", 25000, 300));
      expect('the tour moves on by itself (to the test buy)', await untilStep('testbuy', 8000));
      const hitS = await clickEl('#tourSkip');
      expect('Skip on the test buy takes the click (' + hitS + ')', hitS === 'BUTTON#tourSkip');
    } else {
      const hitL = await clickEl('#tourSkip');
      expect('"Later" takes the click (' + hitL + ')', hitL === 'BUTTON#tourSkip');
    }
    expect('"what I do" is next', await untilStep('reactions', 5000));
    expect('the panel is put away for the demos', await until("document.getElementById('panel').hidden", 5000));

    // ---- what I do ----------------------------------------------------------------------------
    const hitP = await clickEl('#tour [data-demo=profit]');
    expect('the Profit demo takes the click (' + hitP + ')', /BUTTON/.test(hitP));
    expect('and she reacts', await until("['cheer','happy','jump','wave'].includes(window.__petInfo().state) || (window.__pet && window.__pet.glow > 0)", 8000, 150));
    await shot('t04-profit.png');
    const hitLoss = await clickEl('#tour [data-demo=loss]');
    expect('the Loss demo takes the click (' + hitLoss + ')', /BUTTON/.test(hitLoss));
    await sleep(800);
    const hitN = await clickEl('#tourNext');
    expect('Next takes the click (' + hitN + ')', hitN === 'BUTTON#tourNext');
    expect('the last card', await untilStep('done', 5000));
    const hitGo = await clickEl('#tourNext');
    expect('"Let\'s go" takes the click (' + hitGo + ')', hitGo === 'BUTTON#tourNext');
    expect('the tour is over', await until("!window.__petTour.state().active && document.getElementById('tour').hidden", 5000));
    expect('and remembered', await js("YuiWeb.settings.tourDone === true && JSON.parse(localStorage.getItem('yui.web.settings.v2')).tourDone === true"));
    await shot('t05-done.png');
    expect('no page errors', pageErrors.length === 0);
  } catch (e) {
    console.error('[tour-test] crashed:', e);
    results.push(['no crash', false]);
    try { await shot('t99-crash.png'); } catch {}
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`[tour-test] ${results.length - failed.length}/${results.length} passed` + (pageErrors.length ? '\n[tour-test] page errors:\n  ' + pageErrors.join('\n  ') : ''));
  app.exit(failed.length ? 1 : 0);
});
