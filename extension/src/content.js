// Yui on a trading site. The content script.
//
// Everything she is — walk cycle, drag and throw, her panel, the board, the trade reactions — is
// the same bundle the desktop app and the website run. This file is the third container for it,
// after Electron and a plain tab: it gives the renderer a place to live on a page that belongs to
// someone else, and the handful of things a page cannot do for an extension.
//
//   a shadow root      the site's stylesheet cannot touch her and hers cannot touch the site; the
//                      renderer's `document` is a stand-in (__YUI_DOC) that answers from that root
//   chrome.storage     one setup — wallet, look, size — that follows the trader to every site
//   the background     her relay socket is opened by the extension's worker, not the page, so a
//                      plain ws:// relay works from an https site (__YUI_WS)
//   a frame cap        a trading terminal is already busy; she can be told to take 30 fps (__YUI_RAF)
//
// The bundle is built with `document`, `WebSocket` and `requestAnimationFrame` pointed at those
// three globals, so nothing in the renderer or the website's bridge had to learn about any of it.
'use strict';

const STORE = 'yui.web.settings.v2';          // her settings, the key yui-boot.js uses
const EXT = 'yui.ext';                        // the extension's own: { off: { host: true }, fps }
// Over TLS through Caddy on the relay box.
const PUBLIC_RELAY = 'wss://relay.tradingcompanion.fun';
const HOST_TAG = 'yui-companion';             // a custom element name: no site stylesheet has a rule for it
const DEV = typeof YUI_DEV !== 'undefined' && YUI_DEV;


// ---- storage: chrome.storage.local, read once, then kept in memory -----------------------------
// yui-boot.js expects synchronous get/set (it reads settings at boot). So the whole store is read
// before she boots, and every write goes to memory first and to chrome.storage behind it.
const mem = {};
function storageGet(keys) { return new Promise((res) => chrome.storage.local.get(keys, (v) => res(v || {}))); }
function storageSet(obj) { return new Promise((res) => chrome.storage.local.set(obj, () => res())); }
function storageRemove(k) { return new Promise((res) => chrome.storage.local.remove(k, () => res())); }
const storage = {
  get: (k) => (k in mem ? mem[k] : null),
  set: (k, v) => { mem[k] = v; storageSet({ [k]: v }); },
  remove: (k) => { delete mem[k]; storageRemove(k); },
};
function extPrefs() {
  let p = {};
  try { p = JSON.parse(mem[EXT] || '{}') || {}; } catch { p = {}; }
  if (!p.off || typeof p.off !== 'object') p.off = {};
  p.fps = p.fps === 30 ? 30 : 0;
  return p;
}

// ---- the frame loop: cap and pause ---------------------------------------------------------------
let fpsCap = 0, paused = false, lastFrame = 0;
const nativeRaf = window.requestAnimationFrame.bind(window);
window.__YUI_RAF = function (fn) {
  return nativeRaf(function tick(ts) {
    if (paused) { pendingFrame = fn; return; }                 // resumed later, from where it stopped
    if (fpsCap && ts - lastFrame < 1000 / fpsCap - 2) { nativeRaf(tick); return; }
    lastFrame = ts; frames++; fn(ts);
  });
};
let frames = 0;   // drawn so far; the popup's status carries it, the self-test watches it stop
let pendingFrame = null;
function setPaused(v) {
  paused = v;
  if (!v && pendingFrame) { const f = pendingFrame; pendingFrame = null; window.__YUI_RAF(f); }
}

// ---- the socket: a WebSocket look-alike over a port to the background worker ----------------------
// The renderer uses exactly: new WebSocket(url), onopen/onmessage/onerror/onclose, readyState,
// close(), and the OPEN constant. If the worker cannot be reached (an extension reload while the
// page stayed open, or a browser that does not run it), it falls back to a real socket — which
// works on http and is refused on https, exactly as the page would have been.
const NativeWebSocket = window.WebSocket;
class YuiSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = YuiSocket.CONNECTING;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this._port = null; this._native = null; this._ping = 0;
    let port = null;
    try { if (chrome.runtime && chrome.runtime.id) port = chrome.runtime.connect({ name: 'yui-relay' }); } catch { port = null; }
    if (!port) { this._direct(); return; }
    this._port = port;
    let heard = false;
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object') return;
      heard = true;
      if (m.type === 'open') { this.readyState = YuiSocket.OPEN; window.__yuiSocketPath = 'background'; if (this.onopen) this.onopen({}); }
      else if (m.type === 'message') { if (this.onmessage) this.onmessage({ data: m.data }); }
      else if (m.type === 'error') { if (this.onerror) this.onerror({}); }
      else if (m.type === 'close') { this._closed(m.code, m.reason); }
    });
    port.onDisconnect.addListener(() => {
      // Never answered at all: no worker on this browser. Try the page's own socket instead.
      if (!heard && this.readyState === YuiSocket.CONNECTING) { this._port = null; this._direct(); return; }
      this._closed(1006, 'extension background stopped');
    });
    port.postMessage({ type: 'open', url: this.url });
    this._ping = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { /* closed */ } }, 20000);
  }
  _direct() {
    let ws;
    try { ws = new NativeWebSocket(this.url); } catch (e) { setTimeout(() => { if (this.onerror) this.onerror({}); this._closed(1006, e.message); }); return; }
    this._native = ws; window.__yuiSocketPath = 'direct';
    ws.onopen = () => { this.readyState = YuiSocket.OPEN; if (this.onopen) this.onopen({}); };
    ws.onmessage = (ev) => { if (this.onmessage) this.onmessage({ data: ev.data }); };
    ws.onerror = () => { if (this.onerror) this.onerror({}); };
    ws.onclose = (ev) => this._closed(ev.code, ev.reason);
  }
  _closed(code, reason) {
    if (this.readyState === YuiSocket.CLOSED) return;
    this.readyState = YuiSocket.CLOSED;
    clearInterval(this._ping);
    if (this._port) { try { this._port.disconnect(); } catch { /* gone */ } this._port = null; }
    if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
  }
  send(data) {
    if (this._native) return this._native.send(data);
    if (this._port) this._port.postMessage({ type: 'send', data: String(data) });
  }
  close(code, reason) {
    if (this.readyState >= YuiSocket.CLOSING) return;
    this.readyState = YuiSocket.CLOSING;
    if (this._native) { try { this._native.close(code, reason); } catch { /* fine */ } return; }
    if (this._port) { try { this._port.postMessage({ type: 'close' }); } catch { /* gone */ } }
    this._closed(1000, reason || '');
  }
}
YuiSocket.CONNECTING = 0; YuiSocket.OPEN = 1; YuiSocket.CLOSING = 2; YuiSocket.CLOSED = 3;
window.__YUI_WS = YuiSocket;

// ---- her place on the page --------------------------------------------------------------------
// One host element, fixed over the whole viewport and transparent to the pointer; inside its shadow
// root the same four elements the app's window has, plus a stand-in for <body> that the renderer
// appends its canvases to. The stylesheet is the app's, adapted by the build (yui.css).
let hostEl = null, shadow = null, bodyEl = null, docStyle = null, booted = false;

const DOC_CSS = `
@font-face { font-family: "Rubik"; src: url("__RUBIK__") format("woff2"); font-weight: 300 900; font-display: swap; }
@font-face { font-family: "Outfit"; src: url("__OUTFIT__") format("woff2"); font-weight: 100 900; font-display: swap; }
/* while she is in hand the cursor sweeps across a page full of text */
html.yui-grabbing, html.yui-grabbing body { user-select: none !important; -webkit-user-select: none !important; cursor: grabbing !important; }
`;

function buildHost() {
  hostEl = document.createElement(HOST_TAG);
  hostEl.id = 'yui-host';
  shadow = hostEl.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = chrome.runtime.getURL('yui.css');
  shadow.appendChild(link);
  for (const id of ['loading', 'bubble', 'tour', 'panel']) {
    const d = document.createElement('div');
    d.id = id;
    if (id === 'tour' || id === 'panel') d.hidden = true;
    if (id === 'loading') d.textContent = 'Loading…';
    shadow.appendChild(d);
  }
  bodyEl = document.createElement('div');
  bodyEl.id = 'yui-body';
  shadow.appendChild(bodyEl);
  // @font-face inside a shadow root does not register; the page's head gets the two faces.
  docStyle = document.createElement('style');
  docStyle.id = 'yui-doc-style';
  docStyle.textContent = DOC_CSS.replace('__RUBIK__', chrome.runtime.getURL('fonts/Rubik.woff2')).replace('__OUTFIT__', chrome.runtime.getURL('fonts/Outfit.woff2'));
  // A <link> only loads once it is in the document, so she is attached first; a short cap keeps a
  // browser that never fires the event from holding her boot forever.
  attach();
  return new Promise((res) => { const t = setTimeout(res, 3000); link.onload = link.onerror = () => { clearTimeout(t); res(); }; });
}

// The renderer's `document`. Lookups by id and the body go to her shadow root; everything else is
// the real document, with methods bound so the browser sees the genuine receiver.
window.__YUI_DOC = new Proxy(document, {
  get(t, k) {
    if (k === 'getElementById') return (id) => (shadow ? shadow.getElementById(id) : null);
    if (k === 'querySelector') return (s) => (shadow ? shadow.querySelector(s) : null);
    if (k === 'querySelectorAll') return (s) => (shadow ? shadow.querySelectorAll(s) : []);
    if (k === 'body') return bodyEl || t.body;
    const v = t[k];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});

function attach() {
  if (!docStyle.isConnected) (document.head || document.documentElement).appendChild(docStyle);
  if (!hostEl.isConnected) document.documentElement.appendChild(hostEl);
}
function detach() {
  if (hostEl && hostEl.isConnected) hostEl.remove();
  if (docStyle && docStyle.isConnected) docStyle.remove();
}

// ---- her boot ------------------------------------------------------------------------------------
function sizeForViewport(w, h) {
  // A terminal is dense; she takes the lower part of the screen, not half of it, until told otherwise.
  return Math.min(window.YUI_DEFAULTS ? window.YUI_DEFAULTS.sizePx : 640, Math.round(Math.min(h * 0.42, w * 0.6)));
}

async function boot() {
  await buildHost();
  window.YUI_CONFIG = {
    relay: PUBLIC_RELAY,
    storage,
    sharedPage: true,
    allowPlainWs: true,                   // the worker opens the socket; no mixed-content rule applies
    size: sizeForViewport,
    // A terminal keeps its chart and its order box in the middle; she first appears towards the
    // right edge, out of the way, and stays wherever she is dragged to. That spot is remembered per
    // site rather than per page: a terminal opens a new path for every token.
    spawn: 0.9,
    placeKey: location.hostname,
    reload: () => location.reload(),      // "reset her" starts over, the way the site does
  };
  window.YuiExt.boot();
  const S = window.YUI_SOUNDS || { map: {}, files: [] };
  const sounds = { map: S.map, files: S.files.map((f) => ({ name: f.name, url: chrome.runtime.getURL(f.url) })) };
  booted = true;
  await window.YuiWeb.start({ model: chrome.runtime.getURL('assets/yui.vrm'), sounds });
}

// ---- the popup and the other tabs ------------------------------------------------------------------
function status() {
  const r = window.YuiWeb ? window.YuiWeb.relay() : { status: 'off', info: '', trades: 0, connected: false };
  return {
    host: location.hostname, shown: !!(hostEl && hostEl.isConnected), booted,
    ready: document.documentElement.classList.contains('yui-ready'),
    wallet: window.YuiWeb ? window.YuiWeb.wallet() : '', relay: r, socket: window.__yuiSocketPath || null, fps: fpsCap || 60, frames,
  };
}

async function main() {
  if (DEV) window.YUI_DEBUG = true;                          // the renderer's bridge.log lines reach the console
  Object.assign(mem, await storageGet([STORE, EXT]));   // an explicit list: not every Chromium accepts null for "everything"
  const prefs = extPrefs();
  fpsCap = prefs.fps;
  const host = location.hostname;
  if (!prefs.off[host]) await boot();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(changes)) {
      const nv = changes[k].newValue;
      if (mem[k] === nv) continue;                            // our own write coming back
      if (nv === undefined) delete mem[k]; else mem[k] = nv;
      if (k === EXT) {
        const p = extPrefs();
        fpsCap = p.fps;
        const off = !!p.off[location.hostname];
        if (off && hostEl) { detach(); setPaused(true); }
        else if (!off && !booted) boot().catch((e) => console.error('[yui]', e));
        else if (!off && hostEl) { attach(); setPaused(false); }
      } else if (k === STORE && window.YuiWeb) {
        // Another tab, or the popup, changed her settings: take the wallet (that is what the popup
        // edits) and reconnect if it changed. Look and size stay per tab until the next load.
        let s = {}; try { s = JSON.parse(nv || '{}') || {}; } catch { s = {}; }
        if (typeof s.wallets === 'string' && s.wallets !== window.YuiWeb.wallet()) {
          window.YuiWeb.setWallet(s.wallets);
          if (s.wallets) window.YuiWeb.connect(); else window.YuiWeb.disconnect();
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || typeof m !== 'object') return false;
    if (m.type === 'status') { reply(status()); return false; }
    if (m.type === 'open-panel' && window.YuiWeb && hostEl && hostEl.isConnected) { window.YuiWeb.openPanel(m.tab || 'wallet'); reply({ ok: true }); return false; }
    return false;
  });

  if (DEV) devBridge();
}

// ---- the self-test's way in (development builds only; compiled out of the release) ----------------
// A test drives her from the page's own world, where extension globals are out of reach. It sends
// a CustomEvent carrying a JSON string — a command name and its arguments — and the reply comes
// back the same way. Strings only: an object handed across worlds arrives as nothing. A fixed table
// rather than eval: an extension's content script may not evaluate code at all.
function devBridge() {
  const Y = () => window.YuiWeb;
  const q = (sel) => (shadow ? shadow.querySelector(sel) : null);
  const COMMANDS = {
    advance: (sec) => window.__petAdvance(sec),
    info: () => window.__petInfo(),
    mouse: (type, x, y) => { window.__petMouse(type, x, y); },
    synthetic: (on) => { window.__petSyntheticOnly = on !== false; },
    save: (patch) => { Y().save(patch); },
    settings: () => Y().settings,
    relay: () => Y().relay(),
    setWallet: (w) => { Y().setWallet(w); },
    connect: () => { Y().connect(); },
    status: () => status(),
    socketPath: () => window.__yuiSocketPath || null,
    // hand her a relay frame / open her panel — for screenshots and tests without a live wallet
    relayMsg: (m) => { window.__petRelayMsg(typeof m === 'string' ? JSON.parse(m) : m); },
    openPanel: (tab) => { Y().openPanel(tab || 'wallet'); },
    pet: (patch) => { Object.assign(window.__pet, patch || {}); },
    sign: () => window.__petSign(),
    storageGet: (key) => new Promise((r) => chrome.storage.local.get(key, (v) => r(v ? v[key] : null))),
    storageSet: (obj) => new Promise((r) => chrome.storage.local.set(obj, () => r(true))),
    proxyCheck: () => !!shadow && window.__YUI_DOC.getElementById('panel') === shadow.getElementById('panel') && document.getElementById('panel') !== shadow.getElementById('panel'),
    // her DOM, one fact at a time
    shadow: (sel, what) => {
      const el = q(sel);
      if (what === 'exists') return !!el;
      if (!el) return null;
      if (what === 'hidden') return !!el.hidden;
      if (what === 'value') return el.value;
      if (what === 'text') return el.textContent;
      if (what === 'rect') { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }
      if (what === 'webHidden') return !!el.closest('.web-hide');
      return null;
    },
  };
  document.addEventListener('yui-test', (e) => {
    let req; try { req = JSON.parse(e.detail); } catch { return; }
    const done = (ok, value) => document.dispatchEvent(new CustomEvent('yui-test-result', { detail: JSON.stringify({ id: req.id, ok, value }) }));
    const fn = COMMANDS[req.cmd];
    if (!fn) { done(false, 'unknown command ' + req.cmd); return; }
    let out;
    try { out = fn.apply(null, Array.isArray(req.args) ? req.args : []); } catch (err) { done(false, String(err && err.message || err)); return; }
    Promise.resolve(out).then((v) => done(true, v === undefined ? null : v), (err) => done(false, String(err && err.message || err)));
  });
  document.documentElement.dataset.yuiDev = '1';
}

// Only the top frame. A terminal has iframes (charts, wallets) and she would otherwise appear in each.
if (window.top === window && typeof chrome !== 'undefined' && chrome.storage) main().catch((e) => console.error('[yui]', e && e.stack || e));
