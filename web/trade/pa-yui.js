// Yui's ears on the paper-trading page.
//
// This page is Paperxiom's token page — Axiom's chrome, a lightweight-charts pane, paper orders
// on the real pump.fun bonding curve — copied into her website (scripts/build-web.js does the
// copy from the paper-axiom checkout). Embedded in the front page, every paper fill and every
// chart tick is handed to the parent page as exactly the messages her relay sends for a real
// wallet, so what she does here is what she does for real money. Standalone, it stays quiet.
(function () {
  'use strict';
  // API, Mock and Curve are top-level consts in their files: reachable by name, not on window
  if (window.parent === window || typeof API === 'undefined' || typeof Mock === 'undefined') return;
  var SOL = Mock.SOL_PRICE || 100;
  var MINT = null, n = 0;
  function post(m) { m.yui = 1; parent.postMessage(m, location.origin); }

  // ?tape=<url> replays a real token's history (scripts/tape-from-db.js) instead of the mock world
  var tape = API.tape;
  var TAPE_URL = new URLSearchParams(location.search).get('tape');
  API.tape = function (mint) {
    if (TAPE_URL) return fetch(TAPE_URL).then(function (r) { return r.json(); }).then(function (t) {
      MINT = t.mint; window.__paTape = t; rename(t.sym, t.name); return t;
    });
    MINT = mint; return tape.call(API, mint);
  };

  // The captured page has its own token's name baked into places the controller never touches —
  // the header's symbol, the tooltip title, the embedded map. Whatever tape is loaded, those read
  // as that tape's token.
  var CAPTURED_SYM = 'GIKO', CAPTURED_NAME = 'The First Internet Cat';
  function rename(sym, name) {
    // This page is 3.6 MB of captured markup, so the sweep is cheap and rare: it runs when the
    // browser is idle, only over the parts that carry a name (the header row and the document
    // title), and only twice — once now and once after the app has finished its first render.
    var pass = function () {
      var scope = document.querySelector('.platform-main-content') || document.body;
      var w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT), n, seen = 0;
      while ((n = w.nextNode()) && seen++ < 4000) {
        var v = (n.nodeValue || '').trim();
        if (!v || v.length > 40) continue;
        if (v === CAPTURED_SYM || /^GIK[^A-Za-z]*$/.test(v)) n.nodeValue = n.nodeValue.replace(/GIKO|GIK/, sym);
        else if (v === CAPTURED_NAME) n.nodeValue = name;
      }
      if (document.title.indexOf(CAPTURED_SYM) >= 0) document.title = document.title.split(CAPTURED_NAME).join(name).split(CAPTURED_SYM).join(sym);
      var imgs = scope.querySelectorAll('img[alt*="GIKO"],[title*="GIKO"]');
      for (var i = 0; i < imgs.length; i++) ['alt', 'title'].forEach(function (k) {
        var t = imgs[i].getAttribute(k);
        if (t) imgs[i].setAttribute(k, t.split(CAPTURED_NAME).join(name).split(CAPTURED_SYM).join(sym));
      });
    };
    var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 1); };
    idle(pass);
    setTimeout(function () { idle(pass); }, 1200);
  }

  // a fill, as the relay would report it: SOL-equivalent amounts, the market cap it printed at,
  // and for a sell the realised result against the cost of what was sold
  function wrap(name) {
    var orig = API[name];
    API[name] = function (o) {
      var before = Mock.pos(o.mint);
      var costBefore = before ? before.cost_sol : 0, tokBefore = before ? before.tokens : 0;
      return orig.call(API, o).then(function (d) {
        if (!d || !d.ok) return d;
        var f = d.fill, p = d.pos;
        var m = {
          type: 'trade', paper: 1, side: f.side, wallet: 'PAPER', mint: o.mint, symbol: p.sym || '', name: p.sym || '',
          venue: 'pump.fun', quote: 'SOL', quoteKind: 'sol', quoteSymbol: 'SOL',
          amount: f.sol, tokens: f.tokens, mcQuote: f.mc_usd / SOL, mcUsd: f.mc_usd, solUsd: SOL,
          remainingTokens: p.tokens, remainingCost: p.cost_sol, sig: 'paper-' + (++n), ts: f.ts || Date.now(),
        };
        if (f.side === 'sell' && tokBefore > 0) {
          var costSold = costBefore * Math.min(1, f.tokens / tokBefore);
          m.pnl = f.sol - costSold;
          m.pnlPct = costSold > 0 ? 100 * m.pnl / costSold : 0;
          m.cost = costSold;
        }
        post(m);
        return d;
      });
    };
  }
  wrap('buy'); wrap('sell');

  // the chart's last bar, whenever it moves: the same throttled tick the relay forwards while you hold
  var last = 0;
  setInterval(function () {
    if (!MINT) return;
    var cur = 0;
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { var w = frames[i].contentWindow; if (w && w.PAChart && w.PAChart.cur) { cur = w.PAChart.cur(); break; } } catch (e) {}
    }
    if (!(cur > 0) || cur === last) return;
    last = cur;
    post({ type: 'price', paper: 1, mint: MINT, price: cur / SOL / 1e9, quote: 'SOL', quoteKind: 'sol', mcQuote: cur / SOL, mcUsd: cur, solUsd: SOL, ts: Date.now() });
  }, 500);

  // when the parent asks, act like the page's own buttons (the tests use this; a person clicks)
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.yui !== 'order' || !window.__paTrade) return;
    window.__paTrade.order(e.data.side, e.data.arg);
  });
})();
