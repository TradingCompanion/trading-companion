// Yui, living on the page.
//
// The renderer gives her a body, physics and a voice; the bridge (yui-boot.js) makes her run in a
// tab. This file makes the page hers: on a first visit the page waits, greyed out, while she
// introduces herself; after that she answers the things you click on and comes over when you tap
// the empty page. Everything is a nudge to states she already has — nothing here animates
// her by hand.
//
// A page opts in per element:
//   <button data-yui-say="…">                       a line for when it is clicked
//   <a data-yui-say="…" data-yui-mood="up">         …and a mood: up (happy), down (a wince), wow
//   [data-yui-hover="…"]                            a line for when the pointer rests on it
//
// She stays out of the way of her own tour and panel: while either is up, scrolling does not
// walk her off, and only clicks meant for the page are answered.
(function () {
  'use strict';
  var W = window.YuiWeb;
  if (!W) return;
  var CFG = window.YUI_CONFIG || {};

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ready = false;
  W.on('ready', function () { ready = true; });

  // ---- what she is up to -----------------------------------------------------------------------
  function info() { return W.info(); }
  function tourUp() { return W.tourRunning(); }
  function free() {                              // can she be sent somewhere / spoken for right now?
    var i = info();
    if (!ready || !i || tourUp()) return false;
    return ['idle', 'walk', 'sit', 'wave'].indexOf(i.state) >= 0;
  }
  var lastSay = 0;
  function say(text, secs, minGap) {
    if (!text || !ready) return;
    var now = Date.now();
    if (now - lastSay < (minGap || 1500)) return;
    lastSay = now;
    W.say(text, secs || 3.5);
  }
  function walkTo(frac) {
    if (!free() || reduce) return false;
    return !!(window.__petWalkTo && window.__petWalkTo(Math.round(frac * window.innerWidth)));
  }
  // A walk asked for while she is busy — cheering, being thrown, mid-tour — is kept and tried
  // again for a few seconds, so a scroll during a reaction still brings her along afterwards.
  var pending = 0;
  function walkSoon(frac) {
    clearInterval(pending);
    if (walkTo(frac)) return;
    var tries = 0;
    pending = setInterval(function () {
      if (walkTo(frac) || ++tries > 12) clearInterval(pending);
    }, 600);
  }
  function mood(kind) {
    if (!ready) return;
    if (kind === 'up') { if (window.__petFx) window.__petFx.glow(0.25); W.command('wave'); }
    else if (kind === 'down') { if (window.__petFlinch) window.__petFlinch(); }
    else if (kind === 'wow' && window.__petJump) window.__petJump();
  }

  // ---- the first visit: the page waits while she says hello ------------------------------------
  // Mandatory, and deliberately so: the site is greyed out and cannot be used until she has
  // introduced herself and asked your name — the beginning of her tour. The rest of the
  // tour then carries on with the page free (every later step can be skipped). A visit that ends
  // before the name is given meets her again next time; a name given once is remembered.
  var INTRO = 'yui.web.intro.v1';
  function introDone() { try { return !!localStorage.getItem(INTRO); } catch (e) { return false; } }
  // The glass is in the page's own markup and shown by a one-line script in <head> before the
  // first paint (html.yui-intro), so a first visit never shows a frame of the bare page.
  // A known visitor skips the trailer and the glass; the tour still greets them (below).
  var intro = CFG.intro && !introDone() ? document.getElementById('yui-intro') : null;
  if (intro && !document.documentElement.classList.contains('yui-intro')) document.documentElement.classList.add('yui-intro');
  if (!intro) { var stale = document.getElementById('yui-intro'); if (stale) stale.remove(); }
  if (intro) {
    window.__yuiIntroStates = [];
    W.on('state', function (st) { if (intro) window.__yuiIntroStates.push(st); });
    var release = function () {
      if (!intro) return;
      try { localStorage.setItem(INTRO, String(Date.now())); } catch (e) {}
      intro.classList.add('out');
      document.documentElement.classList.remove('yui-intro');
      var el = intro; intro = null;
      setTimeout(function () { el.remove(); }, 800);
    };
    var begun = false;
    var begin = function () {
      if (begun) return; begun = true;
      // She is standing at her spot. The loader goes, she fades in, and as she appears she waves
      // and says hello (the tour's first card). Nothing in between.
      intro.classList.add('here');
      if (window.__petTour) window.__petTour.start();
      var watch = setInterval(function () {
        var st; try { st = window.__petTour.state(); } catch (e) { st = null; }
        if (!st || !st.active || st.step !== 'name') { clearInterval(watch); release(); }
      }, 250);
    };
    // If she cannot load at all, the glass says so and lets go — a page that cannot scroll behind
    // a girl who is never coming is the worst thing this file could do.
    W.on('failed', function () {
      var t = intro && intro.querySelector('#introTxt');
      if (t) t.textContent = "She couldn't load — refresh to try again.";
      setTimeout(function () {
        if (!intro) return;
        intro.classList.add('out');
        document.documentElement.classList.remove('yui-intro');
        var el = intro; intro = null;
        setTimeout(function () { el.remove(); }, 800);          // the visitor keeps the site
      }, 3000);
    });
    // With a starter page in front (the guided trade), the hello waits until that is over.
    var starterFirst = !!CFG.starter;
    W.on('ready', function () { if (!starterFirst) begin(); });
    window.YuiIntro = { begin: function () { if (ready && intro) begin(); else if (intro) W.on('ready', begin); } };
    window.addEventListener('yui-starter-done', function () { window.YuiIntro.begin(); });
  }
  // No glass owed (she has met this visitor): the tour still runs once the lesson is over and she
  // is back at her spot. It is how the site introduces her, so it is not conditional — the visitor
  // can step through it in a few clicks, and her ❔ replays it whenever they want.
  if (!intro) {
    window.YuiIntro = { begin: function () {
      var go = function () { try { if (window.__petTour && !window.__petTour.state().active) window.__petTour.start(); } catch (e) {} };
      if (ready) go(); else W.on('ready', go);
    } };
    window.addEventListener('yui-starter-done', function () { window.YuiIntro.begin(); });
    // No lesson in front of her — a phone, or a page without one — so the tutorial is hers to
    // start as soon as she is on screen, the way it runs after the lesson everywhere else.
    if (!CFG.starter) W.on('ready', function () { setTimeout(function () { window.YuiIntro.begin(); }, 900); });
    W.on('failed', function () {
      var t = document.getElementById('loadTxt');
      if (t) t.textContent = "she couldn't load — refresh to try again";
      document.documentElement.classList.add('yui-failed');
    });
  }

  // ---- clicks: she answers what you press ------------------------------------------------------
  // Her canvas catches the pointer wherever the renderer last saw her, a frame ago; a click that
  // lands on it is hers only if it is actually on her.
  function herOwn(el, e) {
    if (!el || !el.closest) return false;
    if (el.tagName === 'CANVAS') return !e || !window.__petHitAt || !!window.__petHitAt(e.clientX, e.clientY);
    return !!el.closest('#panel, #tour, #bubble, #yui-dock');
  }
  var lastClick = { t: 0, x: 0, y: 0 };
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t || herOwn(t, e) || !ready) return;
    // Two quick presses in one spot are a double-click, counted here rather than waited for as a
    // dblclick event: the bridge withholds those from the renderer, and some input paths never
    // synthesise one at all.
    var now = Date.now(), dbl = now - lastClick.t < 380 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 14;
    lastClick = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY };
    if (dbl && !t.closest('a, button, input, select, textarea, label')) {
      if (free() && window.__petJump) { window.__petJump(); say(pick(['Hup!', 'Wheee~', 'Boing!']), 2, 0); }
      return;
    }
    // a section's line belongs to scrolling into it, not to a click anywhere inside it
    var el = t.closest('[data-yui-say]:not([data-yui-x]), [data-yui-mood]');
    if (el) {
      var m = el.getAttribute('data-yui-mood');
      if (m) mood(m);
      say(el.getAttribute('data-yui-say'), 3.5, 400);
      return;
    }
    // a press on the bare page: she comes over, unless it landed on something that does its own thing
    if (t.closest('a, button, input, select, textarea, label, [role=button]')) return;
    var i = info();
    if (!i) return;
    var near = Math.abs(e.clientX - i.screenX) < i.heightPx * 0.55 && e.clientY > i.screenY - i.heightPx;
    if (near) {                                   // beside her, not on her: a poke in the air
      if (window.__petPoke) window.__petPoke();
      say(pick(['Hm?', 'Yes~?', 'That tickles.', 'I saw that.']), 2, 800);
      return;
    }
    if (walkTo(e.clientX / window.innerWidth)) say(pick(['Coming~', 'On my way!', 'Okay okay~', 'Be right there.']), 2, 800);
  });

  // ---- hovering: a word about what the pointer rests on ----------------------------------------
  var hoverTimer = 0, hovered = null;
  document.addEventListener('mouseover', function (e) {
    var t = e.target instanceof Element ? e.target.closest('[data-yui-hover]') : null;
    if (t === hovered) return;
    hovered = t;
    clearTimeout(hoverTimer);
    if (!t) return;
    hoverTimer = setTimeout(function () { if (hovered === t) say(t.getAttribute('data-yui-hover'), 3, 4000); }, 650);
  });

  // ---- paper trades from the embedded chart page ----------------------------------------------
  // trade/token.html (Paperxiom's page, copied in) posts each paper fill and chart tick shaped
  // exactly like the relay's messages; they go straight into the handler real trades go into.
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.yui !== 1 || !ready) return;
    if (window.__petRelayMsg) window.__petRelayMsg(e.data);
  });

  // ---- the wallet going live is worth a cheer --------------------------------------------------
  var wasLive = false;
  W.on('relay', function (r) {
    if (r.connected && !wasLive && ready && !tourUp()) { if (window.__petCelebrate) window.__petCelebrate('Live!'); }
    wasLive = r.connected;
  });

  // ---- the tab going away and coming back ------------------------------------------------------
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && ready && !tourUp() && !intro) { W.command('wave'); say(pick(['Welcome back~', 'You came back!', 'Hi again!']), 3, 0); }
  });

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  // the page reports her download so the first visit is never a silent dark screen
  var slowSaid = false, firstByteAt = Date.now();
  function progress(p) {
    if (!intro) return;
    var bar = intro.querySelector('#introBar'), txt = intro.querySelector('#introTxt');
    if (bar) bar.style.width = Math.round(p * 100) + '%';
    if (!txt) return;
    if (p >= 1) { txt.textContent = 'Waking her up…'; return; }
    // on a phone connection she is a real download; say so rather than looking stuck
    if (!slowSaid && Date.now() - firstByteAt > 6000 && p < 0.9) slowSaid = true;
    txt.textContent = 'Downloading her… ' + Math.round(p * 100) + '%' + (slowSaid ? ' · she is 9 MB, one moment' : '');
  }
  window.YuiPage = { walkTo: walkTo, say: say, free: free, progress: progress, introRunning: function () { return !!intro; } };
})();
