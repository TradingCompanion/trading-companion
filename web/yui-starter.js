// The starter: the first thing anyone sees.
//
// The page opens as the terminal — Paperxiom's Axiom view, replaying a real token's history,
// frozen a moment before it ran — with Yui standing beside it. One guided paper trade: Buy here,
// watch it run while she keeps the board, freeze at the top, Sell, and see what she does with a
// win. Then it slides away and the site (and her hello) is underneath. Everyone gets it; a
// returning visitor gets a Skip.
//
// Nothing here is scripted about her: the terminal's paper fills and ticks reach her through the
// same messages a real wallet's trades do (trade/pa-yui.js), so the reactions are her real ones.
(function () {
  'use strict';
  var CFG = window.YUI_CONFIG || {};
  var S = CFG.starter;
  var root = document.getElementById('starter');
  if (!S || !root) { if (root) root.remove(); document.documentElement.classList.remove('yui-starter'); return; }
  // The girl in the lesson is her own copy, in a transparent frame over the terminal; the site's
  // Yui is not started until this is over. `W` is whichever one the lesson is driving.
  var yuiFrame = null, W = null;
  function api() { try { return yuiFrame && yuiFrame.contentWindow && yuiFrame.contentWindow.YuiWeb; } catch (e) { return null; } }
  // Always an object: end() and the walk call through this, and a throw inside end() would leave
  // the lesson on screen with `done` already set — unclosable.
  function pet() { try { return (yuiFrame && yuiFrame.contentWindow) || {}; } catch (e) { return {}; } }
  var frameBox = root.querySelector('#starterFrame'), hint = root.querySelector('#starterHint');
  var eyebrow = root.querySelector('#starterEyebrow'), text = root.querySelector('#starterText');
  var skip = root.querySelector('#starterSkip'), cap = root.querySelector('#starterCap');
  // The terminal is rendered at a fixed 1600x900 and the card shows only the band that matters:
  // the token header, the chart and the buy ticket. Everything below (positions, holders, the
  // map) is simply outside the crop, so the chart has the card to itself — no surgery on the
  // captured page, which is what broke when it was tried.
  var PAGE_W = 1600, BAND_H = 592;
  var introDone = false; try { introDone = !!localStorage.getItem('yui.web.intro.v1'); } catch (e) {}
  skip.hidden = !introDone;                      // the first time through, there is no way around it

  var done = false, frame = null, tape = null, step = 0, timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  // everything the lesson listens to, so it can let go of the page when it leaves
  var onResize = function () { sizeCard(); };
  var onResizeHint = function () { placeHint(); };
  var keepPlaced = 0;
  function end() {
    if (done) return; done = true;
    timers.forEach(clearTimeout);
    timers.forEach(clearInterval);
    clearInterval(keepPlaced);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('resize', onResizeHint);
    stopAiming();
    // the screen fades out on the lesson, and fades back in on the site with the real Yui
    root.classList.add('out');
    setTimeout(function () {
      document.documentElement.classList.remove('yui-starter');
      root.remove();                                   // the lesson's Yui goes with it
      window.dispatchEvent(new Event('yui-starter-done'));
    }, 800);
  }
  skip.addEventListener('click', end);

  function say(t, secs) { var w = api(); if (w && w.say) w.say(t, secs || 4); }
  function ctl() { try { return frame && frame.contentWindow && frame.contentWindow.__paTrade; } catch (e) { return null; } }
  function chartUp() {
    try {
      var fr = frame.contentWindow.document.querySelectorAll('iframe');
      for (var i = 0; i < fr.length; i++) { var c = fr[i].contentWindow; if (c && c.PAChart && c.PAChart.bars && c.PAChart.bars() > 0) return true; }
    } catch (e) {}
    return false;
  }
  // the order button in page pixels: the terminal is drawn scaled inside its box
  function btnRect() {
    var c = ctl(); if (!c) return null;
    var o = frame.getBoundingClientRect(), r = c.TR.go.getBoundingClientRect();
    var k = o.width / (frame.offsetWidth || o.width);
    return { x: o.left + r.left * k, y: o.top + r.top * k, w: r.width * k, h: r.height * k };
  }
  // the hint sits above the order button, whichever side it is showing
  // the card: as wide as the page allows, as tall as the band scaled to that width, and never
  // taller than the room between the title and the bottom edge
  function sizeCard() {
    if (!frame) return;
    var w = frameBox.clientWidth || frameBox.getBoundingClientRect().width;
    var top = frameBox.getBoundingClientRect().top;
    var room = Math.max(240, window.innerHeight - top - 54);
    var k = Math.min(w / PAGE_W, room / BAND_H);
    var cw = Math.round(PAGE_W * k), ch = Math.round(BAND_H * k);
    frameBox.style.width = cw + 'px';
    frameBox.style.height = ch + 'px';
    frame.style.transform = 'scale(' + k + ')';
    if (cap) cap.style.top = Math.round(top + ch + 16) + 'px';
    placeHint(); placeShield();
  }
  window.addEventListener('resize', onResize);

  // Nothing in the terminal is clickable during the lesson except the one button she is pointing
  // at: four panes cover the card and leave a hole over it, so a click there reaches the real
  // button and a click (or a scroll, or a drag on the chart) anywhere else does not.
  var shield = null;
  function shieldOn() {
    if (shield) return;
    shield = document.createElement('div');
    shield.className = 'shield';
    for (var i = 0; i < 4; i++) shield.appendChild(document.createElement('i'));
    root.appendChild(shield);
    placeShield();
  }
  function placeShield() {
    if (!shield) return;
    var c = frameBox.getBoundingClientRect(), b = btnRect();
    var pad = 6;
    var hx = b ? b.x - pad : c.right, hy = b ? b.y - pad : c.bottom;
    var hw = b ? b.w + pad * 2 : 0, hh = b ? b.h + pad * 2 : 0;
    var p = shield.children;
    var set = function (el, l, t, w, h) { el.style.cssText = 'left:' + Math.round(l) + 'px;top:' + Math.round(t) + 'px;width:' + Math.round(Math.max(0, w)) + 'px;height:' + Math.round(Math.max(0, h)) + 'px'; };
    set(p[0], c.left, c.top, c.width, hy - c.top);                       // above the hole
    set(p[1], c.left, hy + hh, c.width, c.bottom - (hy + hh));           // below it
    set(p[2], c.left, hy, hx - c.left, hh);                              // left of it
    set(p[3], hx + hw, hy, c.right - (hx + hw), hh);                     // right of it
  }

  function placeHint() {
    placeShield();
    var b = btnRect(); if (!b || hint.hidden) return;
    // above the button, nudged right so her arm and stick (from the lower left) stay clear of
    // the words, and never off the page
    var w = hint.offsetWidth || 320, x = b.x + b.w / 2 - 10;
    x = Math.max(16 + w / 2, Math.min(window.innerWidth - 16 - w / 2, x));
    hint.style.left = Math.round(x) + 'px';
    hint.style.top = Math.round(b.y - 12) + 'px';
  }
  function show(step_, eb, html) { step = step_; eyebrow.textContent = eb; text.innerHTML = html; hint.hidden = false; hint.classList.remove('pop'); void hint.offsetWidth; hint.classList.add('pop'); placeHint(); }

  // ---- open the terminal on the real tape, frozen where the story starts --------------------------
  fetch(S.tape).then(function (r) { return r.json(); }).then(function (t) {
    tape = t;
    frame = document.createElement('iframe');
    frame.title = 'Paper trading terminal';
    // the page lives in trade/, so the tape's address must not be relative to this page
    var tapeUrl = new URL(S.tape, location.href).pathname;
    frame.src = 'trade/token.html?tape=' + encodeURIComponent(tapeUrl) + '&at=' + t.freeze_at + '&paused=1&lesson=1';
    // the card shows the moment the terminal has painted — it does not wait for her to download
    frame.addEventListener('load', function () { sizeCard(); frameBox.classList.add('up'); });
    frameBox.appendChild(frame);
    // her own copy, over the card: transparent, and never in the way of a click
    yuiFrame = document.createElement('iframe');
    yuiFrame.className = 'yui';
    yuiFrame.title = 'Yui';
    yuiFrame.setAttribute('allow', 'autoplay');
    yuiFrame.src = 'lesson-yui.html';
    root.appendChild(yuiFrame);
    sizeCard();
    if (cap) cap.textContent = '$' + t.sym + ' · ' + new Date(t.launch_time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    var t0 = Date.now();
    var poll = setInterval(function () {
      var c = ctl();
      if (c && chartUp()) { clearInterval(poll); later(armed, 300); return; }
      // the terminal never came up (a failed load, a blocked frame): step aside rather than leave
      // a first-time visitor looking at a card with no way past it
      if (Date.now() - t0 > 30000) { clearInterval(poll); console.warn('[starter] the terminal did not load'); end(); }
    }, 250);
    timers.push(poll);
  }).catch(function (e) { console.error('[starter]', e); end(); });

  // ---- the terminal is up: she says hello, walks over to the button and points at it ----------------
  function armed() {
    var c = ctl(); if (!c) return end();
    root.classList.add('ready');
    frameBox.classList.add('up');
    shieldOn();
    sizeCard();
    // one size fits the story: 1 SOL, and only Buy for now
    try { c.TR.presets[2].click(); } catch (e) {}
    c.TR.presets.forEach(function (p) { p.style.pointerEvents = 'none'; });
    c.TR.amt.readOnly = true;
    c.TR.sellBtn.style.pointerEvents = 'none';
    c.TR.quickBtn.style.display = 'none';
    whenHer(function () {
      // hello while she is already on her way: a wave, the line, and the walk right behind it
      var w0 = api(); if (w0 && w0.command) w0.command('wave');
      say('Hi! I\'m Yui~ Come, let me show you something.', 4);
      later(function () {
        // the card and her line come as she sets off, so nothing is ever waiting on her feet;
        // the arm goes up when she gets there
        show(1, 'Step 1 of 2', 'Press <b>Buy</b> — one SOL into $' + tape.sym + ' — and watch her.');
        say('Go on, press Buy~ Then keep your eyes on me.', 5);
        walkToButton(function () {
          if (pet().__petStay) pet().__petStay(true);      // she keeps her place beside the board
          pointAtButton();
        });
      }, 1700);
    });
  }
  // she may still be downloading when the terminal is ready
  function whenHer(fn) {
    if (herReady) return fn();
    herWaiting.push(fn);
    // she is a 9 MB download. If she has not arrived by now the lesson runs without her — the
    // card and the buy still work — rather than sitting there with nobody to teach it.
    later(function () {
      if (herReady || done) return;
      herReady = true;
      var q = herWaiting; herWaiting = [];
      q.forEach(function (f) { try { f(); } catch (e) { console.error('[starter]', e); } });
    }, 25000);
  }
  function buttonX() { var b = btnRect(); return b ? b.x + b.w / 2 : window.innerWidth * 0.7; }
  function info() { var w = api(); return w && w.info ? w.info() : null; }
  function spotX() { var i = info(); var w = i ? i.heightPx : 640; return Math.max(0.22 * window.innerWidth, Math.min(buttonX() - 0.42 * w, window.innerWidth - 0.3 * w)); }
  // the walk, with the arrival taken from her own state change rather than a poll — no beat
  // between her last step and the point
  function walkToButton(then) {
    var target = spotX(), t0 = Date.now(), fired = false;
    var near = function (i) { return Math.abs(i.screenX - target) < i.heightPx * 0.2; };
    var arrive = function () { if (fired) return; fired = true; off(); clearInterval(iv); then(); };
    var w0 = api();
    var off = w0 && w0.on ? w0.on('state', function (st) { var i = info(); if (i && st !== 'walk' && near(i)) arrive(); }) : function () {};
    var iv = setInterval(function () {
      if (done) { off(); clearInterval(iv); return; }
      var i = info(); if (!i) return;
      if (near(i) && i.state !== 'walk') return arrive();
      if (i.state !== 'walk' && Date.now() - t0 > 3500) return arrive();   // she stopped short: point from where she is
      if (i.state !== 'walk' && pet().__petWalkTo) pet().__petWalkTo(target);   // a cheer or a hop refuses for a moment: ask again
      if (Date.now() - t0 > 25000) arrive();                                  // however she got there
    }, 150);
    timers.push(iv);
  }
  // With the stick, at the button — asked for immediately, then kept aimed (the button moves when
  // the card resizes, and she may be mid-cheer the first time she is asked).
  var aim = 0;
  function pointAtButton() {
    clearInterval(aim);
    var tick = function () {
      var b = btnRect(); if (!b || done) { clearInterval(aim); return; }
      // she aims at the card, which sits on the button with its arrow touching it: the pointer,
      // the card and the button read as one gesture, and it is inside what her arm can reach
      var h = hint.hidden ? null : hint.getBoundingClientRect();
      var tx = h ? h.left + h.width * 0.5 : b.x + b.w / 2;
      var ty = h ? h.top + h.height * 0.55 : b.y;
      if (pet().__petPointAt) pet().__petPointAt(tx, ty, 40);
    };
    tick();
    aim = setInterval(tick, 400);
    timers.push(aim);
  }
  function stopAiming() { clearInterval(aim); if (pet().__petUnpoint) pet().__petUnpoint(); }

  // the market cap the tape was frozen at — what a buy here pays, if the fill has not said so yet
  function mcAtFreeze() {
    if (!tape) return 0;
    var mc = 0;
    for (var i = 0; i < tape.t.length && tape.t[i] <= tape.freeze_at; i++) mc = tape.mc[i];
    return mc;
  }

  // ---- her fills come back as the relay's messages; the story moves on them ----------------------
  var herReady = false, herWaiting = [], buyMc = 0;
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.yuiLesson === 'ready') {
      herReady = true; W = api();
      var q = herWaiting; herWaiting = [];
      q.forEach(function (fn) { later(function () { if (!done) fn(); }, 250); });
      return;
    }
    // every paper fill and tick goes to the lesson's Yui — the site's is not running yet
    if (e.data.yui === 1 && !done) { var p = pet(); if (p && p.__petRelayMsg) p.__petRelayMsg(e.data); }
    if (e.data.yui !== 1 || e.data.type !== 'trade' || done) return;
    var c = ctl(); if (!c) return;
    if (e.data.side === 'buy' && step === 1) {
      buyMc = Number(e.data.mcUsd) || 0;
      // step 2: let it run, up to the top, and hold there; she stays where she is, board out
      step = 2; hint.hidden = true;
      stopAiming();
      c.stopAt(tape.top_at);
      c.play(true);
      later(function () { say('Now watch~ I keep the board.', 4); }, 1500);
      var wait = setInterval(function () {
        if (done) { clearInterval(wait); return; }
        var k = ctl(); if (!k) return;
        if (!k.playing() && k.clock() >= tape.top_at - 1) { clearInterval(wait); atTop(); }
      }, 200);
      timers.push(wait);
    } else if (e.data.side === 'sell' && step === 3) {
      // step 4: her win — then the site
      step = 4; hint.hidden = true;
      stopAiming();
      later(end, 4200);
    }
  });
  function atTop() {
    var c = ctl(); if (!c) return;
    c.TR.setSide('sell');                         // 100% is the sell tab's default
    c.TR.sellBtn.style.pointerEvents = '';
    c.TR.go.style.pointerEvents = '';
    // from the price the buy actually printed at, not the launch's first print
    var x = tape.ath_mc_usd / (buyMc || mcAtFreeze() || tape.ath_mc_usd);
    // she never left the board, so the pointer goes up the instant it tops out
    pointAtButton();
    show(3, 'Step 2 of 2', 'Up <b>' + x.toFixed(0) + '×</b>. Press <b>Sell</b> and see what she does.');
    say('Ahh, press Sell~ I want to see it!', 5);
  }

  window.addEventListener('resize', onResizeHint);
  keepPlaced = setInterval(placeHint, 400);

  // being asked to end from the outside (tests, or a future "skip" elsewhere)
  window.YuiStarter = { end: end, step: function () { return step; }, frame: function () { return frame; } };
})();
