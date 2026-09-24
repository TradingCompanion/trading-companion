// The website as an experience: she walks to the section you read, answers the page's buttons,
// comes over when you click the empty page, jumps on a double-click — and the docs page loads
// with her in the margin. Real input, like test-web-tour.js.
//
//   npm run test:web:page                 (against http://127.0.0.1:8821/)
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.YUI_WEB_URL || 'http://127.0.0.1:8821/').replace(/\/?$/, '/');
const OUT = process.env.PET_TEST_OUT || __dirname;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const PROFILE = path.join(require('os').tmpdir(), 'yui-web-page-test');
fs.rmSync(PROFILE, { recursive: true, force: true });
app.setPath('userData', PROFILE);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const pageErrors = [];
  wc.on('console-message', (e, level, msg) => {
    if (/Electron Security Warning|GL_INVALID_OPERATION: Level of detail/.test(msg)) return;
    if (level >= 2) pageErrors.push(msg);
    if (process.env.YUI_TEST_VERBOSE || level >= 2) console.log('[page]', msg);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code);
  const results = [];
  const expect = (label, ok) => { results.push([label, ok]); console.log(`[page-test] ${ok ? 'PASS' : 'FAIL'} ${label}`); return ok; };
  const shot = async (name) => { await sleep(150); fs.writeFileSync(path.join(OUT, name), (await wc.capturePage()).toPNG()); };
  const until = async (cond, ms, every) => {
    const t0 = Date.now();
    for (;;) { if (await js(cond)) return true; if (Date.now() - t0 > (ms || 15000)) return false; await sleep(every || 200); }
  };
  const move = async (x, y) => { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await sleep(60); };
  const click = async (x, y, n) => {
    await move(x, y); await sleep(120);
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: n || 1 }); await sleep(60);
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: n || 1 }); await sleep(60);
  };
  const rect = async (sel) => js(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const load = async (page) => {
    await win.loadURL(BASE + page);
    return until("document.documentElement.classList.contains('yui-ready')", 90000, 300);
  };
  const her = () => js('window.__petInfo()');

  try {
    // ---- the starter: the terminal first, one guided paper trade, with real clicks ----------------
    expect('front page loads', await load('index.html'));
    expect('the starter is up before anything else', await js("document.documentElement.classList.contains('yui-starter') && getComputedStyle(document.getElementById('starter')).display === 'block'"));
    expect('a first visit has no way around it', await js("document.getElementById('starterSkip').hidden"));
    expect('the terminal opens on the real tape, frozen before the run', await until("window.YuiStarter && YuiStarter.frame() && YuiStarter.frame().contentWindow.__paTrade && document.documentElement.classList.contains('yui-ready')", 120000, 300) && await js("YuiStarter.frame().contentWindow.__paTrade.clock() === 7715 && !YuiStarter.frame().contentWindow.__paTrade.playing()"));
    // she greets, walks over to the button and points at it; her walk runs on her own clock
    expect('she greets first', await until("/Yui/.test(window.__petBubbleText())", 15000, 200));
    const walkT = Date.now(); let pointed = false;
    while (Date.now() - walkT < 60000 && !pointed) { await js('window.__petAdvance(0.5)'); await sleep(150); pointed = await js("window.__petInfo().state === 'point' && YuiStarter.step() === 1"); }
    await js('window.__petResume()');
    expect('she walks to the board and points at the button with her stick', pointed && await js("window.__petInfo().screenX > 0.5 * innerWidth"));
    expect('the hint says to buy', await js("/Buy/.test(document.getElementById('starterText').textContent) && !document.getElementById('starterHint').hidden"));
    await sleep(1500);
    await shot('p00-starter.png');
    const go1 = await js("(function(){var f=YuiStarter.frame();var o=f.getBoundingClientRect();var k=o.width/f.offsetWidth;var r=f.contentWindow.__paTrade.TR.go.getBoundingClientRect();return {x:o.left+(r.left+r.width/2)*k,y:o.top+(r.top+r.height/2)*k}})()");
    await click(go1.x, go1.y);
    expect('Buy: she takes the paper position and the run starts', await until("YuiStarter.step() === 2 && window.__petPositions().length === 1 && YuiStarter.frame().contentWindow.__paTrade.playing()", 8000, 150));
    // the run: her clock stepped along so the runner ladder can fire between ticks
    const runT = Date.now(); let top = false;
    while (Date.now() - runT < 90000 && !top) { await js('window.__petAdvance(0.6)'); await sleep(200); top = await js("YuiStarter.step() === 3 && /Sell/.test(document.getElementById('starterText').textContent)"); }
    await js('window.__petResume()');
    expect('…and it stops at the top with the hint to sell', top);
    expect('she got excited on the way up (runner ladder)', await js("((window.__petPositions()[0]||{}).runLevel||0) >= 3"));
    expect('the clock is exactly at the top print', await js("YuiStarter.frame().contentWindow.__paTrade.clock() === 25981 && !YuiStarter.frame().contentWindow.__paTrade.playing()"));
    await sleep(600);
    const go2 = await js("(function(){var f=YuiStarter.frame();var o=f.getBoundingClientRect();var k=o.width/f.offsetWidth;var r=f.contentWindow.__paTrade.TR.go.getBoundingClientRect();return {x:o.left+(r.left+r.width/2)*k,y:o.top+(r.top+r.height/2)*k,label:f.contentWindow.__paTrade.TR.go.textContent.trim()}})()");
    expect('the button now sells (' + go2.label + ')', /Sell/.test(go2.label));
    await click(go2.x, go2.y);
    expect('Sell: her win reaction', await until("YuiStarter.step() === 4 && ['cheer','happy','jump'].includes(window.__petInfo().state)", 8000, 150));
    await shot('p00b-starter-win.png');
    expect('the starter slides away into the site', await until("!document.documentElement.classList.contains('yui-starter')", 10000, 200));
    // she walks back to her spot on the left before the hello; her walk runs on her own clock
    const backT = Date.now(); let home = false;
    while (Date.now() - backT < 60000 && !home) { await js('window.__petAdvance(1)'); await sleep(80); home = await js("window.__petInfo().state !== 'walk' && window.__petInfo().screenX < 0.3 * innerWidth"); }
    await js('window.__petResume()');
    expect('she walks back to her spot on the left', home);
    expect('then the first visit: the page is greyed out and cannot scroll', await js("!!document.getElementById('yui-intro') && document.documentElement.classList.contains('yui-intro') && getComputedStyle(document.body).overflow === 'hidden'"));
    expect('the glass sits under her and over the page', await js("+getComputedStyle(document.getElementById('yui-intro')).zIndex < +getComputedStyle(document.getElementById('yui-stage')).zIndex && +getComputedStyle(document.getElementById('yui-intro')).zIndex > +getComputedStyle(document.querySelector('.nav')).zIndex"));
    // Software rendering runs her clock at a fraction of real time, so her wake (0.9 s of her
    // time) and the beat after it are stepped along here; on a GPU they take exactly that long.
    const stepUntilTour = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms && !(await js("window.__petTour.state().active"))) { await js('window.__petAdvance(0.4)'); await sleep(120); }
      await js('window.__petResume()');
    };
    expect('and she says hello right away', await until("window.__petTour.state().active && window.__petTour.state().step === 'name'", 6000, 150));
    const s0 = await her();
    expect('she is standing at her spot (' + s0.state + ', ' + Math.round(s0.screenX) + 'px)', s0.screenX < 0.3 * 1600 && s0.onGround);
    await shot('p00-hello.png');
    const s1 = await her();
    expect('she is at her spot on the left (' + Math.round(s1.screenX) + 'px)', s1.screenX < 0.3 * 1600);
    expect('the page is still greyed out while she asks', await js("!!document.getElementById('yui-intro') && !document.getElementById('yui-intro').classList.contains('out')"));
    await shot('p00-intro.png');
    // the name field is reachable through the glass (the card is above it)
    const nm = await rect('#tourName');
    await click(nm.x, nm.y);
    expect('the name field takes a click through the glass', await js("document.activeElement && document.activeElement.id === 'tourName'"));
    await wc.insertText('Alex');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'char', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    expect('giving a name frees the page', await until("!document.documentElement.classList.contains('yui-intro') && (!document.getElementById('yui-intro') || document.getElementById('yui-intro').classList.contains('out'))", 6000, 150));
    expect('and the tour carries on, skippable, with the page free', await js("window.__petTour.state().active && window.__petTour.state().step === 'click' && getComputedStyle(document.body).overflow !== 'hidden'"));
    expect('the intro is remembered', await js("!!localStorage.getItem('yui.web.intro.v1')"));

    // ---- a browser that remembers where she was, but has not met her: she still walks in -------
    await js("YuiWeb.save({ pageX: { '/index.html': YuiWeb.settings.x } }); localStorage.removeItem('yui.web.intro.v1')");
    expect('intro again: loads', await load('index.html'));
    expect('the starter again (no intro yet, so no skip)', await until("window.YuiStarter && YuiStarter.step() === 1", 90000, 300) && await js("document.getElementById('starterSkip').hidden"));
    await js('YuiStarter.end()');
    await until("!document.documentElement.classList.contains('yui-starter')", 8000, 200);
    for (let i = 0; i < 20 && !(await js("window.__petTour.state().active")); i++) { await js('window.__petAdvance(0.5)'); await sleep(150); }
    await js('window.__petResume()');
    const r0 = await her();
    expect('she is at her spot despite a remembered one, saying hello (' + Math.round(r0.screenX) + 'px)', r0.screenX < 0.3 * 1600 && await js("window.__petTour.state().active && window.__petTour.state().step === 'name'"));
    const r1 = await rect('#tourName'); await click(r1.x, r1.y); await wc.insertText('Alex');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'char', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until("!document.documentElement.classList.contains('yui-intro')", 6000, 150);

    // ---- second visit: no glass, she is at her spot, the page is hers --------------------------
    await js('YuiWeb.save({ tourDone: true })');
    expect('front page loads again: the starter, with Skip for a returning visitor', await load('index.html') && await until("window.YuiStarter && YuiStarter.frame() && YuiStarter.frame().contentWindow.__paTrade", 120000, 300) && await js("!document.getElementById('starterSkip').hidden"));
    const sk = await rect('#starterSkip'); await click(sk.x, sk.y);
    expect('Skip takes the click and the site is there, no intro, no tour', await until("!document.documentElement.classList.contains('yui-starter') && document.getElementById('tour').hidden && !document.getElementById('yui-intro')", 8000, 200));
    for (let i = 0; i < 20 && !(await js("window.__petInfo().state !== 'walk' && window.__petInfo().screenX < 0.3 * innerWidth")); i++) { await js('window.__petAdvance(0.5)'); await sleep(150); }
    await js('window.__petResume()');
    await sleep(2500);
    const i0 = await her();
    expect('she starts on the left at the app\'s size', i0.screenX < 0.3 * 1600 && i0.heightPx === 640);
    expect('the header links are wired (GitHub, X, docs)', await js("/github\\.com/.test(document.getElementById('navGh').href) && /x\\.com/.test(document.getElementById('navX').href) && !!document.querySelector('a[href=\"docs.html\"]')"));
    expect('fonts and logo are served', await js("fetch('fonts/Outfit.woff2',{method:'HEAD'}).then(r=>r.ok)") && await js("document.querySelector('.brand img').naturalWidth > 0"));
    expect('the domain is tradingcompanion.fun', await js("/tradingcompanion\\.fun/.test(document.querySelector('footer .fb').textContent) && !/trenchwaifu\\.fun/.test(document.documentElement.outerHTML)"));
    await shot('p01-hero.png');
    await js("document.getElementById('her').scrollIntoView({ behavior: 'instant', block: 'start' })"); await sleep(400);
    await shot('p02-cards.png');

    // ---- clicks: the page's buttons and the empty page ---------------------------------------
    const card = await rect('#her .card.win');
    await click(card.x, card.y);
    expect('clicking a card gets a line from her', await until("/love winning/i.test(window.__petBubbleText())", 5000, 150));
    await js('window.__petAdvance(4)'); await js('window.__petResume()');
    await js("window.scrollTo({ top: 0, behavior: 'instant' })"); await sleep(400);
    await until("window.__petInfo().state === 'idle'", 8000, 200);
    // the bare page, to her right: she walks over (she is pinned during the lesson; not after it)
    await js('window.__petStay && window.__petStay(false)');
    console.log('[page-test] under the page click:', await js("(function(){var e=document.elementFromPoint(880,840);return e?e.tagName+'#'+e.id+'.'+e.className:'none'})()"));
    await click(880, 840);
    const over = await until("window.__petInfo().state === 'walk' && window.__pet.walkTarget > window.__pet.x", 6000, 150);
    let there = false;
    for (let i = 0; i < 10 && !there; i++) { await js('window.__petAdvance(2)'); there = await js("window.__petInfo().state === 'idle'"); }
    await js('window.__petResume()');
    expect('clicking the empty page brings her over' + (over ? '' : ' (' + await js("JSON.stringify({state:window.__petInfo().state, sx:Math.round(window.__petInfo().screenX), target:+window.__pet.walkTarget.toFixed(2), x:+window.__pet.x.toFixed(2), bubble:window.__petBubbleText()})") + ')'), over);
    const p = await her();
    // a double-click: two presses in one spot, quickly — on bare hero, clear of her and her dock
    const dx = Math.min(Math.round(p.screenX + 420), 1150), dy = 130;
    console.log('[page-test] under the double-click:', await js(`(function(){var e=document.elementFromPoint(${dx},${dy});return e?e.tagName+'#'+e.id+'.'+e.className:'none'})()`));
    await move(dx, dy); await sleep(120);
    for (const n of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x: dx, y: dy, button: 'left', clickCount: n }); await sleep(40);
      wc.sendInputEvent({ type: 'mouseUp', x: dx, y: dy, button: 'left', clickCount: n }); await sleep(60);
    }
    expect('a double-click on the page makes her jump', await until("!window.__petInfo().onGround || window.__pet.bob > 0.005 || window.__petInfo().state === 'jump'", 6000, 80));
    await js('window.__petAdvance(3)'); await js('window.__petResume()');
    await shot('p03-back-home.png');

    // ---- the docs page -----------------------------------------------------------------------
    expect('the docs page loads with her', await load('docs.html'));
    expect('docs contents column and sections', await js("document.querySelectorAll('aside a').length >= 12 && document.querySelectorAll('section.doc').length >= 10"));
    const okDocs = await until("document.getElementById('tour').hidden && window.__petInfo().heightPx <= 480 && window.__petInfo().screenX < 0.2 * innerWidth", 8000, 200);
    expect('docs: no tour, she is smaller and in the margin' + (okDocs ? '' : ' (' + await js("JSON.stringify({tour:!document.getElementById('tour').hidden, h:window.__petInfo().heightPx, sx:Math.round(window.__petInfo().screenX), x:YuiWeb.settings.x, pageX:YuiWeb.settings.pageX})") + ')'), okDocs);
    await shot('p04-docs.png');
    await js("document.getElementById('relay').scrollIntoView({ behavior: 'instant' }); window.dispatchEvent(new Event('scroll'))");
    await shot('p05-docs-relay.png');
    expect('no page errors', pageErrors.length === 0);
  } catch (e) {
    console.error('[page-test] crashed:', e);
    results.push(['no crash', false]);
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`[page-test] ${results.length - failed.length}/${results.length} passed` + (pageErrors.length ? '\n[page-test] page errors:\n  ' + pageErrors.join('\n  ') : ''));
  app.exit(failed.length ? 1 : 0);
});
