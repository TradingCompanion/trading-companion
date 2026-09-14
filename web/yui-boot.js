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
  var STORE = 'yui.web.settings.v1';
  var CFG = window.YUI_CONFIG || {};

  // ---- the relay -------------------------------------------------------------------------------
  // A page served over https may only open wss://. The public relay is plain ws:// today, so the
  // scheme follows the page and `mixedContent()` below says plainly why nothing will connect when
  // the two cannot be reconciled — rather than leaving a visitor with "connection failed".
  var RELAY_HOST = CFG.relayHost || 'relay.trenchwaifu.fun';
  var RELAY_PORT = CFG.relayPort || 9998;
  var HTTPS = location.protocol === 'https:';
  function defaultRelay() {
    if (CFG.relay) return CFG.relay;
    return (HTTPS ? 'wss://' : 'ws://') + RELAY_HOST + ':' + RELAY_PORT;
  }
  // True when she is pointed at a plaintext relay from an https page: the browser will refuse the
  // socket before it is ever opened, and no amount of retrying changes that.
  function mixedContent() {
    return HTTPS && /^ws:\/\//i.test(settings.relayUrl || '');
  }

  // ---- settings ------------------------------------------------------------------------------
  // The desktop app keeps these in settings.json; here they live in the visitor's own browser, so
  // whatever they change on her stays changed when they come back.
  // Anything missing from this list is silently dropped on reload — `load()` only restores keys it
  // knows — so every field her panel can write has to appear here.
  var DEFAULTS = {
    sizePx: 300, alwaysOnTop: true, x: null,
    volume: 0.55, pitch: 1.35, muted: true,     // muted until they ask for sound: autoplay is rude
    bust: 1, jiggle: 1,
    hips: 0.5, waist: 0.5, thighs: 0.5, headSize: 0.5,   // 0.5 is the model as authored
    // Her look on the website is deliberately not the app's default: this is the character the
    // landing page was designed around.
    outfit: 'black', cleavage: 1, topStyle: 'sleeveless', bottomStyle: 'skirt', skirtLen: 0.3, bow: false,
    hairColor: '#000000', eyeColor: '#ffffff',
    customVest: '#1a1a20', customSkirt: '#1a1a20', customBow: '#f2c73f',
    // The board used to be off here, because a browser had no wallet feed to put on it. It has
    // one now, so these match the app.
    sign: true, signSize: 0.5, signStyle: 1, signHold: 'two', solPrice: 101.95, plush: true,
    wallets: '', relayUrl: '', relayToken: '', autoConnect: false,
    sounds: {}, defaultSounds: {}, soundFiles: [], build: 'web',
    // True once the visitor picks a size in her panel. Until then her size follows the viewport,
    // and must never be written back — otherwise one visit on a phone would leave her tiny on
    // that person's desktop forever.
    userSized: false,
  };

  function load() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) {}
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var j in saved) if (j in DEFAULTS) out[j] = saved[j];
    return out;
  }
  var settings = load();
  if (!settings.relayUrl) settings.relayUrl = defaultRelay();
  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) {}
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
  function adopt() {
    var loose = document.querySelectorAll('body > canvas');
    for (var i = 0; i < loose.length; i++) stage.appendChild(loose[i]);
  }

  // ---- the bridge ----------------------------------------------------------------------------
  var canvases = function () { return document.querySelectorAll('#yui-stage canvas, body > canvas'); };
  var bundledModel = null;   // kept so "back to the bundled model" needs no second download

  window.pet = {
    onCursor: register('cursor'),
    onSettings: register('settings'),
    onModel: register('model'),
    onCommand: register('command'),

    // The app makes its whole window click-through unless the cursor is over her. The web analogue
    // is her canvas: transparent to the pointer until the renderer says she is under the cursor,
    // so the page behind her stays completely usable.
    setIgnore: function (v) {
      var list = canvases();
      for (var i = 0; i < list.length; i++) list[i].style.pointerEvents = v ? 'none' : 'auto';
      document.body.style.cursor = v ? '' : 'grab';
      if (v !== overHerNow) { overHerNow = v; emit('hover', !v); }
    },

    contextMenu: function () {},                 // no native menu here; a click opens her panel
    editMenu: function () {},                    // the browser has its own
    openExternal: function (u) { window.open(u, '_blank', 'noopener'); },
    setDisplay: function () {},                  // one screen: the tab
    saveState: function (s) { if (s && typeof s.x === 'number') { settings.x = s.x; persist(); } },
    modelReady: function () { document.documentElement.classList.add('yui-ready'); emit('ready'); },
    modelFailed: function () { document.documentElement.classList.add('yui-failed'); emit('failed'); },
    requestModel: function () {},
    log: function (m) { if (window.YUI_DEBUG) console.log('[yui]', m); },

    saveSettings: function (patch) {
      if (!patch) return;
      if (patch.sounds) { settings.sounds = Object.assign({}, settings.sounds, patch.sounds); }
      if ('sizePx' in patch) settings.userSized = true;   // a deliberate choice, worth remembering
      for (var k in patch) if (k !== 'sounds') settings[k] = patch[k];
      persist();
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
  };

  // ---- right-click and double-click belong to the page ----------------------------------------
  // The renderer cancels both globally, which is right for a desktop pet and wrong for a website
  // with text and links. Catch them first and stop them reaching the renderer unless she is the
  // one being clicked.
  var overHerNow = true;
  function overHer(e) {
    var list = canvases();
    for (var i = 0; i < list.length; i++) if (list[i].style.pointerEvents === 'auto' && list[i] === e.target) return true;
    return false;
  }
  ['contextmenu', 'dblclick'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (!overHer(e)) e.stopImmediatePropagation(); }, true);
  });

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
  window.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    window.dispatchEvent(mouseFromTouch('mousemove', t));
    window.dispatchEvent(mouseFromTouch('mousedown', t));
    touching = true;
    grabbed = isGrabbed();
    if (grabbed) e.preventDefault();             // she is in hand: the gesture is ours
  }, { passive: false });
  window.addEventListener('touchmove', function (e) {
    if (!touching || e.touches.length !== 1) return;
    if (!grabbed) return;                        // let the page scroll
    e.preventDefault();
    window.dispatchEvent(mouseFromTouch('mousemove', e.touches[0]));
  }, { passive: false });
  window.addEventListener('touchend', function (e) {
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
  var YuiWeb = {
    settings: settings,
    on: on,
    off: off,

    // Big enough to have presence on a monitor, small enough to leave a phone readable.
    sizeForViewport: function () {
      var w = window.innerWidth, h = window.innerHeight;
      var byW = w < 560 ? 190 : w < 900 ? 250 : w < 1400 ? 310 : 360;
      return Math.round(Math.min(byW, h * 0.31));   // the hero has to fit above her
    },

    // Fetch her body and hand it to the renderer the same way the main process does.
    start: function (opts) {
      opts = opts || {};
      var onProgress = opts.onProgress || function () {};
      if (opts.sounds) { settings.soundFiles = opts.sounds.files; settings.sounds = opts.sounds.map; }
      // Size follows the window unless the visitor has chosen one. Assigned in place rather than
      // through saveSettings, so a viewport-shaped guess is never written to storage.
      if (!settings.userSized) settings.sizePx = YuiWeb.sizeForViewport();
      // Reconnect on load only for someone who already gave her an address; a first-time visitor
      // would otherwise meet "enter a wallet address first" before being told what it is for.
      settings.autoConnect = !!String(settings.wallets || '').trim();

      document.body.appendChild(stage);
      adopt();                                   // the renderer has appended its canvases by now

      if (cb.settings) cb.settings(settings);

      return fetch(opts.model).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var total = Number(res.headers.get('content-length')) || 0;
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

    // Change a setting from the page and keep her panel showing the same thing.
    save: function (patch) {
      window.pet.saveSettings(patch);
      if (cb.settings) cb.settings(settings);
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
