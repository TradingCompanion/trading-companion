// The browser half of Yui.
//
// src/renderer.js talks to Electron through exactly one object, `window.pet`. Define that object
// before the renderer bundle loads and the identical renderer — same walk cycle, same drag and
// throw physics, same spring bones, same panel — runs on a web page. Nothing here is a
// reimplementation; each method is just the browser-shaped answer to a call the desktop app
// answers with native code.
//
// On top of that bridge this file exposes `window.YuiWeb`: a small, stable surface the page and
// the onboarding guide drive her through, so neither has to reach into renderer internals.
(function () {
  'use strict';

  var cb = {};                                  // callbacks the renderer registers with us
  var register = function (k) { return function (fn) { cb[k] = fn; }; };
  var STORE = 'yui.web.settings.v2';
  var CFG = window.YUI_CONFIG || {};
  // Where her settings live: this browser's localStorage, unless the container brings its own —
  // the extension keeps them in chrome.storage, so one setup follows the visitor to every site.
  var storage = CFG.storage || {
    get: function (k) { return localStorage.getItem(k); },
    set: function (k, v) { localStorage.setItem(k, v); },
    remove: function (k) { localStorage.removeItem(k); },
  };
  // True when she stands on a page that is not hers (the extension, on a trading site). The page
  // keeps every event that is not on her, and nothing here may stop or fake one on its behalf.
  var SHARED = !!CFG.sharedPage;
  // Where she was left is remembered under this key: the page by default (the front page and the
  // docs have different room for her), the whole site when the container says so (a terminal).
  var PLACE = CFG.placeKey || location.pathname;

  // ---- the relay -------------------------------------------------------------------------------
  // A page served over https may only open wss://. The public relay is plain ws:// today, so the
  // scheme follows the page and `mixedContent()` below says plainly why nothing will connect when
  // the two cannot be reconciled — rather than leaving a visitor with "connection failed".
  // With no host configured she assumes the relay lives where the page came from, which is how
  // the server-side build is run: one box serves the page on one port and the relay on 9998.
  var RELAY_HOST = CFG.relayHost || location.hostname || 'relay.tradingcompanion.fun';
  var RELAY_PORT = CFG.relayPort || 9998;
  var HTTPS = location.protocol === 'https:';
  function defaultRelay() {
    if (CFG.relay) return CFG.relay;
    return (HTTPS ? 'wss://' : 'ws://') + RELAY_HOST + ':' + RELAY_PORT;
  }
  // True when she is pointed at a plaintext relay from an https page: the browser will refuse the
  // socket before it is ever opened, and no amount of retrying changes that.
  function mixedContent() {
    if (CFG.allowPlainWs) return false;        // the extension opens the socket outside the page
    return HTTPS && /^ws:\/\//i.test(settings.relayUrl || '');
  }

  // ---- settings ------------------------------------------------------------------------------
  // The desktop app keeps these in settings.json; here they live in the visitor's own browser, so
  // whatever they change on her stays changed when they come back — and every visitor has their
  // own, since localStorage is per browser.
  //
  // The values are the app's: yui-defaults.js is generated from defaultSettings() in main.js by
  // the web build, so she looks, sounds and behaves on the page exactly as she does fresh out of
  // the zip — same figure, same outfit, same board, same first-run tour, the greeting, streaks and
  // milestones, the sell nudge, quiet mode. The handful of overrides below are the things a
  // browser tab genuinely cannot do the desktop way, each with its reason.
  //
  // Anything missing from this list is silently dropped on reload — `load()` only restores keys it
  // knows — so every field her panel can write has to appear here. Deriving the list from the app
  // is what keeps that true as the app grows.
  var APP = window.YUI_DEFAULTS;
  if (!APP) throw new Error('yui-defaults.js must load before yui-boot.js (run `npm run build:web`)');
  var DEFAULTS = {};
  for (var dk in APP) DEFAULTS[dk] = APP[dk];
  Object.assign(DEFAULTS, {
    // The relay: the app resolves its public host at boot; here the scheme has to follow the page
    // (see defaultRelay), so the URL is filled in after load() rather than stored as a default.
    relayUrl: '', relayToken: '',
    // No file dialog paths in a browser; the sound list is handed over by start().
    sounds: {}, defaultSounds: APP.sounds || {}, soundFiles: [], build: window.YUI_BUILD || 'web',
    // One screen: the tab. The app's display picker never appears, so the key is inert here.
    display: null, displays: [],
    // The tour says where she lives; on a page that is not the taskbar.
    home: 'page',
    // Where she was left, per page: the front page and the docs have different room for her.
    pageX: {},
    // True once the visitor picks a size in her panel. Until then she is the app's size (640, or
    // as much of that as the window can hold) and that guess must never be written back —
    // otherwise one visit on a phone would leave her tiny on that person's desktop forever.
    userSized: false,
  });
  // A page may adjust a default it has a reason to (the landing page runs its own walkthrough and
  // turns the app's first-run tour off). Values only — the visitor's saved settings still win.
  if (CFG.defaults) Object.assign(DEFAULTS, CFG.defaults);
  var STORE_V1 = 'yui.web.settings.v1';   // the landing-page look; superseded, cleared on sight
  function load() {
    // v1 stored the landing page's deliberately different look; v2 is the app's. Old storage is
    // dropped rather than migrated: it never held a wallet anyone could lose.
    try { storage.remove(STORE_V1); } catch (e) {}
    var saved = {};
    try { saved = JSON.parse(storage.get(STORE) || '{}') || {}; } catch (e) {}
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var j in saved) if (j in DEFAULTS) out[j] = saved[j];
    // 2026-09-24: her colours follow the logo; a visitor saved before that moves to them once
    if (!saved.lookV3) { out.outfit = DEFAULTS.outfit; out.hairColor = DEFAULTS.hairColor; out.eyeColor = DEFAULTS.eyeColor; }
    out.lookV3 = true;
    if (out.solPrice === 101.95) out.solPrice = DEFAULTS.solPrice;   // the old fallback default, moved to 113
    // sounds merge the way the app merges them on boot: the defaults underneath, the visitor's
    // picks on top, so a new default clip reaches an existing install
    out.sounds = Object.assign({}, DEFAULTS.defaultSounds, saved.sounds || {});
    return out;
  }
  var settings = load();
  if (!settings.relayUrl) settings.relayUrl = defaultRelay();
  // Every push hands the renderer this same object, and from then on the renderer's cfg *is* it:
  // a panel change lands in it before saveSettings() is even called. So "did the size change" is
  // answered against the size last pushed, not against the object.
  var pushedSizePx = null;
  function pushSettings() {
    if (!cb.settings) return;
    pushedSizePx = settings.sizePx;
    cb.settings(settings);
  }
  function persist() {
    try { storage.set(STORE, JSON.stringify(settings)); } catch (e) {}
  }

  // ---- a tiny event bus ------------------------------------------------------------------------
  // The page and the guide both want to know when she is grabbed, thrown, dressed or connected.
  // One subscriber list keeps that out of the renderer.
  var subs = {};
  function on(ev, fn) { (subs[ev] || (subs[ev] = [])).push(fn); return function () { off(ev, fn); }; }
  function off(ev, fn) { var a = subs[ev]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  function emit(ev, arg) {
    var a = subs[ev]; if (!a) return;
    for (var i = 0; i < a.length; i++) { try { a[i](arg); } catch (e) { console.error('[yui]', e); } }
  }

  // ---- her stage -------------------------------------------------------------------------------
  // Her canvas is about twice her height square, so on a phone it is wider than the window. Left
  // loose on <body> that surplus becomes real horizontal scroll — the page drifts sideways and
  // anything pinned to the right edge goes with it. A fixed, clipped stage the size of the
  // viewport holds them instead: same coordinates the renderer already computes, nothing to
  // scroll. pointer-events on the stage stays none so her canvas can still opt back in.
  var stage = document.createElement('div');
  stage.id = 'yui-stage';
  // The renderer appends its canvases to document.body — which, inside the extension's shadow
  // root, is a stand-in element rather than the page's body; :scope keeps the query honest either way.
  function adopt() {
    var loose = document.body.querySelectorAll(':scope > canvas');
    for (var i = 0; i < loose.length; i++) stage.appendChild(loose[i]);
  }

  // ---- the bridge ----------------------------------------------------------------------------
  var canvases = function () {
    var a = Array.prototype.slice.call(stage.querySelectorAll('canvas'));
    return a.concat(Array.prototype.slice.call(document.body.querySelectorAll(':scope > canvas')));
  };
  // The element an event actually landed on. From inside a shadow root (the extension) a window
  // listener is handed the host element instead; composedPath still knows the truth.
  function target(e) { return e.composedPath ? e.composedPath()[0] : e.target; }
  var bundledModel = null;   // kept so "back to the bundled model" needs no second download

  window.pet = {
    web: true,                                   // the renderer picks its lighter profile from this
    holdTour: !!CFG.starter,                     // a page with a starter starts her tour itself, after it
    lesson: !!CFG.lesson,                        // the lesson's copy: no daily greeting, no nudges
    onCursor: register('cursor'),
    onSettings: register('settings'),
    onModel: register('model'),
    onCommand: register('command'),

    // The app makes its whole window click-through unless the cursor is over her. The web analogue
    // is her canvas: transparent to the pointer until the renderer says she is under the cursor,
    // so the page behind her stays completely usable.
    setIgnore: function (v) {
      var list = canvases();
      // The hand shows on her canvas only: the panel and the tour card sit above it with their own
      // cursors, and the page around her is not something you can pick up.
      for (var i = 0; i < list.length; i++) { list[i].style.pointerEvents = v ? 'none' : 'auto'; list[i].style.cursor = v ? '' : 'grab'; }
      if (v !== overHerNow) { overHerNow = v; emit('hover', !v); }
    },

    contextMenu: function () {},                 // no native menu here; a click opens her panel
    editMenu: function () {},                    // the browser has its own
    openExternal: function (u) { window.open(u, '_blank', 'noopener'); },
    setDisplay: function () {},                  // one screen: the tab
    saveState: function (s) {
      if (!s || typeof s.x !== 'number') return;
      settings.x = s.x;
      settings.pageX = Object.assign({}, settings.pageX, {});
      settings.pageX[PLACE] = s.x;
      persist();
    },
    modelReady: function () { document.documentElement.classList.add('yui-ready'); emit('ready'); },
    modelFailed: function () { document.documentElement.classList.add('yui-failed'); emit('failed'); },
    requestModel: function () {},
    log: function (m) { if (window.YUI_DEBUG) console.log('[yui]', m); },

    saveSettings: function (patch) {
      if (!patch) return;
      if (patch.sounds) { settings.sounds = Object.assign({}, settings.sounds, patch.sounds); }
      var sizeChanged = 'sizePx' in patch && patch.sizePx !== pushedSizePx;
      if ('sizePx' in patch) settings.userSized = true;   // a deliberate choice, worth remembering
      for (var k in patch) if (k !== 'sounds') settings[k] = patch[k];
      persist();
      // The renderer only takes a new size from a settings push (the desktop's main process sends
      // one back after a size change); without this she stays the old size until the next load.
      if (sizeChanged) pushSettings();
      emit('settings', patch);
    },

    // The desktop app opens a file dialog; a browser has one built in. Her renderer takes an
    // ArrayBuffer either way, so "bring your own VRM" works here exactly as it does in the app —
    // and the file never leaves the visitor's machine.
    pickModel: function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.vrm,.glb,model/gltf-binary';
      inp.style.display = 'none';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return;
        emit('model-loading', f.name);
        f.arrayBuffer().then(function (buf) {
          if (cb.model) cb.model({ name: f.name.replace(/\.(vrm|glb)$/i, ''), buffer: buf });
        }).catch(function (e) { console.error('[yui] model', e); });
      };
      document.body.appendChild(inp);
      inp.click();
    },
    defaultModel: function () { if (cb.model && bundledModel) cb.model(bundledModel); },

    quit: function () {},
    openSoundsFolder: function () {}, rescanSounds: function () {},
    resetSettings: function () { try { storage.remove(STORE); } catch (e) {} (CFG.reload || function () { location.reload(); })(); },   // back to how she came, browser style
  };

  // ---- right-click and double-click belong to the page ----------------------------------------
  // The renderer cancels both globally, which is right for a desktop pet and wrong for a website
  // with text and links. Catch them first and stop them reaching the renderer unless she is the
  // one being clicked.
  var overHerNow = true;
  function overHer(e) {
    var list = canvases();
    var t = target(e);
    for (var i = 0; i < list.length; i++) if (list[i].style.pointerEvents === 'auto' && list[i] === t) return true;
    return false;
  }
  // On a shared page these guards are not needed and would be harmful: stopping propagation here
  // would also stop the site's own listeners, and the renderer already leaves alone whatever is not
  // hers (it only cancels a right-click or a press that actually lands on her or her panel).
  if (!SHARED) ['contextmenu', 'dblclick'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (!overHer(e)) e.stopImmediatePropagation(); }, true);
  });
  // The same goes for a press on the empty page. On the desktop the window is click-through
  // there: the press lands on whatever is behind her and the renderer never hears of it, so her
  // panel stays open and a tour step that opened it is not stranded. Here the page is the window,
  // and without this the renderer would read a press on the backdrop as "put everything away".
  // Only the press is withheld — a release must always reach her, or a drag that ends off her
  // canvas would leave her hanging in the hand; and only real presses, since the self-test's
  // synthetic ones are dispatched on the window itself.
  function hers(e, t) {
    if (!(t instanceof Element)) return true;
    // Her canvas catches the pointer wherever the renderer last saw her — a frame ago. A press
    // on the canvas counts only if it is on her now (or on a badge on her board); anywhere else
    // on that 2.2x-her-height square is the page, as it would be the desktop.
    if (t.tagName === 'CANVAS') return !window.__petHitAt || !!window.__petHitAt(e.clientX, e.clientY);
    return !!t.closest('#panel, #tour, #bubble');
  }
  if (!SHARED) window.addEventListener('mousedown', function (e) { if (e.isTrusted && !hers(e, target(e))) e.stopImmediatePropagation(); }, true);

  // ---- touch ----------------------------------------------------------------------------------
  // The renderer listens for mouse events only. Forward touches as mouse events so she can be
  // dragged on a phone, but only take the gesture over once she has actually been grabbed —
  // otherwise a touch anywhere near her would eat the page scroll.
  var touching = false, grabbed = false;
  function mouseFromTouch(type, t, button) {
    return new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: t.clientX, clientY: t.clientY, button: button || 0, buttons: type === 'mouseup' ? 0 : 1,
    });
  }
  function isGrabbed() {
    try { return window.__petInfo && window.__petInfo().state === 'grabbed'; } catch (e) { return false; }
  }
  // Forwarded touches are synthetic mouse events on the window, which a shared page would also
  // hear as clicks of its own; on a trading site the mouse is enough, so this stays off there.
  if (!SHARED) window.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    // A finger has no hover: the renderer has never seen a cursor at this spot, so it is told
    // where the touch is and given a frame to notice her before the press lands. Without this the
    // first tap is a press on a girl it does not yet know is under the finger.
    window.dispatchEvent(mouseFromTouch('mousemove', t));
    window.dispatchEvent(mouseFromTouch('mousemove', t));
    window.dispatchEvent(mouseFromTouch('mousedown', t));
    touching = true;
    grabbed = isGrabbed();
    if (grabbed) e.preventDefault();             // she is in hand: the gesture is ours
  }, { passive: false });
  if (!SHARED) window.addEventListener('touchmove', function (e) {
    if (!touching || e.touches.length !== 1) return;
    // she may take a frame to close her hand: keep asking while the finger is still on her
    if (!grabbed) { grabbed = isGrabbed(); if (!grabbed) return; }   // otherwise let the page scroll
    e.preventDefault();
    window.dispatchEvent(mouseFromTouch('mousemove', e.touches[0]));
  }, { passive: false });
  if (!SHARED) window.addEventListener('touchend', function (e) {
    if (!touching) return;
    touching = false;
    var t = e.changedTouches[0];
    if (t) window.dispatchEvent(mouseFromTouch('mouseup', t));
    grabbed = false;
  }, { passive: false });

  // ---- watching her ----------------------------------------------------------------------------
  // The renderer has no event system — it is a game loop — so it reports every state change
  // through this one hook. Being told beats sampling: a quick flick of the wrist can pick her up
  // and let go of her inside a single frame, and a poll would simply never see it.
  window.__petOnState = function (state, was) {
    emit('state', state);
    // Dragging her sweeps the cursor across a page full of text, which would otherwise leave a
    // trail of blue selection behind her. The app has no text to select and needs no such guard.
    document.documentElement.classList.toggle('yui-grabbing', state === 'grabbed');
    if (state === 'grabbed') emit('grab');
    if (was === 'grabbed') {
      // releaseGrab() writes the throw velocity before it changes state, so this is the speed she
      // actually left the hand at.
      var p = window.__pet, speed = p ? Math.hypot(p.vx || 0, p.vy || 0) : 0;
      emit('release', speed);
      if (speed > 2.5) emit('throw', speed);
    }
  };

  // The relay has no such hook — it is a socket the renderer owns — so its status is sampled. A
  // connection changing state twice inside 300ms is not a thing a person can perceive anyway.
  var lastRelay = '';
  setInterval(function () {
    var i;
    try { i = window.__petInfo && window.__petInfo(); } catch (e) { return; }
    if (!i) return;
    var key = i.relay + '|' + i.relayInfo + '|' + i.relayTrades;
    if (key !== lastRelay) { lastRelay = key; emit('relay', relayStatus()); }
  }, 300);

  // Her panel is redrawn wholesale by the renderer. Watching for that is how the page knows the
  // panel opened, which tab is showing, and when to re-apply the browser-shaped edits below.
  var panelEl = document.getElementById('panel');
  var lastPanel = { open: null, tab: null };
  function panelTab() {
    var b = panelEl && panelEl.querySelector('.tabs button.on');
    return b ? b.dataset.tab : null;
  }
  function panelWatch() {
    if (!panelEl) return;
    var open = !panelEl.hidden, tab = panelTab();
    // a phone lays her things out by hand (pet.css): the page has to know when her settings are up
    document.documentElement.classList.toggle('yui-panel', open);
    if (open) enhancePanel();
    if (open !== lastPanel.open) { lastPanel.open = open; emit(open ? 'panel-open' : 'panel-close', tab); }
    if (open && tab !== lastPanel.tab) { lastPanel.tab = tab; emit('panel-tab', tab); }
  }
  if (panelEl) {
    new MutationObserver(panelWatch).observe(panelEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  }


  // ---- her panel, in a browser -----------------------------------------------------------------
  // The panel markup is the app's, untouched. A few of its controls only mean something on a
  // desktop, and one field (the wallet) needs different words here — so rather than forking the
  // renderer, this re-applies a small set of edits every time the renderer redraws the panel.
  function enhancePanel() {
    // renderPanel() replaces the panel's innerHTML wholesale, which takes these edits with it. A
    // marker inside that markup is therefore the honest test of "already done": it survives
    // exactly as long as the DOM it belongs to.
    if (!panelEl || panelEl.querySelector('.web-mark')) return;
    var mark = document.createElement('span');
    mark.className = 'web-mark web-hide';
    panelEl.appendChild(mark);

    var q = function (sel) { return panelEl.querySelector(sel); };
    var hideOwner = function (sel, upto) {
      var el = q(sel); if (!el) return;
      var owner = el.closest(upto) || el;
      owner.classList.add('web-hide');
    };
    // A browser tab has no "always on top", no folder to open, and nothing to quit out of.
    hideOwner('#fTop', '.sw');
    hideOwner('#btnSoundsFolder', '.f');
    var foot = q('.foot'); if (foot) foot.classList.add('web-hide');

    var wallet = q('.pg[data-pg="wallet"]');
    if (!wallet) return;

    // What this tab actually is, said once, at the top.
    if (!wallet.querySelector('.web-note')) {
      var note = document.createElement('div');
      note.className = 'web-note';
      note.innerHTML = 'She watches a <b>public address</b> — she never connects a wallet, never asks '
        + 'you to sign anything and cannot move funds. Paste the address you buy from.';
      wallet.insertBefore(note, wallet.firstChild);
    }
    // An https page cannot open a plaintext socket. Say so, instead of "connection failed".
    if (mixedContent() && !wallet.querySelector('.web-note.warn')) {
      var warn = document.createElement('div');
      warn.className = 'web-note warn';
      warn.innerHTML = '<b>Not reachable from this page.</b> ' + esc(location.host) + ' is served over https, '
        + 'so browsers will only let her open a <b>wss://</b> socket, and the public relay is still plain '
        + 'ws://. Her desktop build has no such restriction — take her home and she connects there.';
      wallet.insertBefore(warn, wallet.firstChild);
    }

    // Fold the relay address and token away. They matter to someone pointing her at their own
    // feed, and to nobody else; in front of the wallet field they read as setup you must do.
    var relayF = q('#fRelay') && q('#fRelay').closest('.f');
    var tokenF = q('#fToken') && q('#fToken').closest('.f');
    if (relayF && tokenF && !wallet.querySelector('.web-adv')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'web-adv';
      btn.textContent = 'Use my own relay';
      var shown = panelEl.dataset.adv === '1';
      var sync = function () {
        relayF.classList.toggle('web-hide', !shown);
        tokenF.classList.toggle('web-hide', !shown);
        btn.classList.toggle('open', shown);
        panelEl.dataset.adv = shown ? '1' : '0';
      };
      btn.onclick = function () { shown = !shown; sync(); };
      relayF.parentNode.insertBefore(btn, relayF);
      sync();
    }
  }
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ---- the relay, from the page ----------------------------------------------------------------
  function relayStatus() {
    var r = window.__petRelay && window.__petRelay.status ? window.__petRelay.status() : null;
    return {
      status: r ? r.status : 'off',
      info: r ? r.info : '',
      trades: r ? r.trades : 0,
      connected: !!(r && r.connected && r.status === 'ok'),
      blocked: mixedContent(),
    };
  }

  // ---- starting her up -------------------------------------------------------------------------
  // Until a size is chosen she keeps fitting the window as it changes, the way the app refits
  // to the work area. The renderer already re-lays out on resize; this only updates the number.
  // Not before start() has pushed the first settings: the renderer takes her saved position from
  // that first push only, and a window still being laid out can fire resize (at 0x0) before the
  // page has even called start() — pushing then would spend that first push on nothing.
  var started = false;
  window.addEventListener('resize', function () {
    if (!started || settings.userSized) return;
    var px = YuiWeb.sizeForViewport();
    if (px === settings.sizePx) return;
    settings.sizePx = px;
    pushSettings();
  });

  var YuiWeb = {
    settings: settings,
    on: on,
    off: off,

    // The app's default size (640, "Huge") whenever the window can hold it. Her canvas is 2.2x her
    // height, so on a short or narrow window she scales down to what fits and no further.
    // A page with its own layout around her (the landing page) can hand in its own rule through
    // YUI_CONFIG.size(w, h).
    sizeForViewport: function () {
      var w = window.innerWidth, h = window.innerHeight;
      if (w < 2 || h < 2) return DEFAULTS.sizePx;   // no viewport yet: the app's size until there is one
      if (typeof CFG.size === 'function') return Math.round(CFG.size(w, h));
      // A phone is held close and has a page to read around her: she stands about a third of the
      // screen tall there. On anything wider she is the app's size — Huge — always, whatever the
      // window is and whatever a previous visit picked.
      if (w <= 900) return Math.round(Math.min(300, h * 0.34, w * 0.8));
      return DEFAULTS.sizePx;
    },

    // Fetch her body and hand it to the renderer the same way the main process does.
    start: function (opts) {
      opts = opts || {};
      var onProgress = opts.onProgress || function () {};
      // The clip list is the app's soundFiles; the visitor's own picks stay on top of the defaults.
      if (opts.sounds) {
        settings.soundFiles = opts.sounds.files;
        settings.defaultSounds = opts.sounds.map;
        settings.sounds = Object.assign({}, opts.sounds.map, settings.sounds);
      }
      // Size follows the window unless the visitor has chosen one. Assigned in place rather than
      // through saveSettings, so a viewport-shaped guess is never written to storage.
      // On a PC she always loads Huge: a size picked in her panel lasts for that visit only.
      // (Not in the extension, which brings its own size rule: a trader's pick on a terminal sticks.)
      if (window.innerWidth > 900 && typeof CFG.size !== 'function') settings.userSized = false;
      if (!settings.userSized) settings.sizePx = YuiWeb.sizeForViewport();
      // Where she first appears. The app puts her at the centre; a page can ask for a spot along
      // the width (YUI_CONFIG.spawn, 0 = left edge, 1 = right) so she stands clear of its text.
      // Only until she has walked somewhere: from then on she is where she was left, like the app.
      // The renderer's x is in world units (her height ~1.6 of them) and it clamps to the edges,
      // so a rough conversion is enough.
      var here = settings.pageX && settings.pageX[PLACE];
      if (typeof here === 'number' && !CFG.forceSpawn) settings.x = here;
      else if (typeof CFG.spawn === 'number') settings.x = (CFG.spawn - 0.5) * window.innerWidth / (settings.sizePx / 1.6);
      // autoConnect stays the app's (true): with no wallet yet the panel says "Enter a wallet
      // address first", exactly as it does on the desktop.

      document.body.appendChild(stage);
      adopt();                                   // the renderer has appended its canvases by now

      pushSettings();
      started = true;

      return fetch(opts.model).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // the server may send her gzipped; the stream below yields decompressed bytes, so the
        // honest total is the uncompressed size when the server says what it is
        var total = Number(res.headers.get('x-uncompressed-size')) || Number(res.headers.get('content-length')) || 0;
        if (!res.body || !total) return res.arrayBuffer();
        // stream it so the page can show real progress: she is a big file on a phone connection
        var reader = res.body.getReader(), chunks = [], got = 0;
        return (function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              var all = new Uint8Array(got), at = 0;
              for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], at); at += chunks[i].length; }
              return all.buffer;
            }
            chunks.push(r.value); got += r.value.length;
            onProgress(Math.min(1, got / total));
            return pump();
          });
        })();
      }).then(function (buffer) {
        onProgress(1);
        bundledModel = { name: 'Yui', buffer: buffer };
        if (cb.model) cb.model(bundledModel);
      });
    },

    // let the page drive her, for the "say hi" style buttons
    command: function (c) { if (cb.command) cb.command(c); },
    say: function (text, secs) { if (window.__petSay) window.__petSay(text, secs); },
    info: function () { try { return window.__petInfo ? window.__petInfo() : null; } catch (e) { return null; } },

    // The app's own first-run tour, from a page button (the dock's ❔).
    tour: function () { if (window.__petTour) window.__petTour.start(); },
    tourRunning: function () { try { return !!window.__petTour.state().active; } catch (e) { return false; } },

    // Change a setting from the page and keep her panel showing the same thing.
    save: function (patch) {
      window.pet.saveSettings(patch);
      pushSettings();
      if (window.__petRepanel) window.__petRepanel();
    },
    setMuted: function (m) { YuiWeb.save({ muted: !!m }); },

    openPanel: function (tab) {
      if (tab && window.__petPanelTab) window.__petPanelTab(tab);
      if (window.__petPanel) window.__petPanel(true);
    },
    closePanel: function () { if (window.__petPanel) window.__petPanel(false); },
    // Escape is the renderer's own "put everything away". Sending it beats reaching for an
    // internal that would then have to stay in step.
    closeAll: function () {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    },
    panelOpen: function () { return !!(panelEl && !panelEl.hidden); },
    panelTab: panelTab,

    // ---- her wallet feed -----------------------------------------------------------------------
    wallet: function () { return String(settings.wallets || '').trim(); },
    // A Solana address is base58 and 32-44 characters; the relay rejects anything else outright,
    // so catching it here means a typo gets a useful answer instead of a dropped socket.
    validWallet: function (w) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(w || '').trim()); },
    setWallet: function (w) { YuiWeb.save({ wallets: String(w || '').trim() }); },
    connect: function () { if (window.__petRelay) window.__petRelay.connect(); },
    disconnect: function () { if (window.__petRelay) window.__petRelay.disconnect(); },
    relay: relayStatus,
    relayBlocked: mixedContent,

    // ---- showing her off -----------------------------------------------------------------------
    // The same code path a real fill takes, with a made-up fill: the glow, the bruises, the voice
    // line and the pose are all her actual reactions, not a canned animation.
    react: function (kind) {
      var r = window.__petReact;
      if (!r) return;
      if (kind === 'buy') return r({ side: 'buy', symbol: 'MOON', quote: 'SOL', amount: 0.5 });
      if (kind === 'profit') return r({ side: 'sell', symbol: 'PEPE', quote: 'SOL', amount: 1.42, pnl: 0.61, pnlPct: 75 });
      if (kind === 'bigProfit') return r({ side: 'sell', symbol: 'GIGA', quote: 'SOL', amount: 6.8, pnl: 4.2, pnlPct: 260 });
      if (kind === 'loss') return r({ side: 'sell', symbol: 'WOJAK', quote: 'SOL', amount: 0.31, pnl: -0.24, pnlPct: -44 });
      if (kind === 'bigLoss') return r({ side: 'sell', symbol: 'RUGME', quote: 'SOL', amount: 0.12, pnl: -1.6, pnlPct: -88 });
    },
    heal: function () { if (window.__petFx) { window.__petFx.heal(1); } },
    // A made-up bag whose market cap wanders, so the board has something to say. Her panel's own
    // "Test position" button turns the board on first if it is off; so must this, or the demo runs
    // with nothing to draw on.
    board: function () {
      if (settings.sign === false) YuiWeb.save({ sign: true });
      if (window.__petDemoSign) window.__petDemoSign();
      return YuiWeb.boardOn();
    },
    // The demo bag expires on its own after half a minute, so this reads the truth rather than
    // remembering what was last clicked.
    boardOn: function () { try { return !!window.__petSign().content; } catch (e) { return false; } },
  };
  window.YuiWeb = YuiWeb;
})();
