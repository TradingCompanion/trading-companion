// The first ninety seconds.
//
// Yui on this page is the desktop pet, not a video of it — but nothing about a 3D girl standing on
// a landing page tells a visitor that she can be picked up, thrown, dressed and pointed at a
// wallet. So she introduces herself, and a small card walks through the four things she does, each
// step completing only when the visitor actually does it. It is skippable, it remembers that it
// has been seen, and it can be replayed from her dock.
//
// Every step here watches a real signal from the renderer (YuiWeb's events), never a timer
// pretending the action happened.
(function () {
  'use strict';

  var SEEN = 'yui.web.tour.v2';
  var W = window.YuiWeb;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  // ------------------------------------------------------------------ the wallet widget
  // The same control appears in the tour card and in the page's own "watch your wallet" section.
  // One binder, so the two can never drift apart or disagree about the connection state.
  var WALLET_HELP = 'That is not a Solana address — they are 32 to 44 letters and digits.';
  function bindWallet(root) {
    var input = $('[data-w=addr]', root), btn = $('[data-w=go]', root), out = $('[data-w=status]', root);
    if (!input || !btn) return null;

    input.value = W.wallet();

    function paint() {
      var r = W.relay();
      btn.textContent = r.connected ? 'Disconnect' : r.status === 'connecting' ? 'Connecting…' : 'Watch it';
      root.classList.toggle('live', r.connected);
      if (!out) return;
      if (r.blocked) {
        out.className = 'w-status err';
        out.textContent = 'This page is on https, so browsers only allow a wss:// relay — the public one is still plain ws://. She connects fine in the desktop build.';
        return;
      }
      if (r.status === 'off' && !r.info) { out.className = 'w-status'; out.textContent = 'Nothing is watched yet.'; return; }
      out.className = 'w-status ' + (r.status === 'ok' ? 'ok' : r.status === 'err' ? 'err' : '');
      out.textContent = r.info || '';
    }

    function go() {
      if (W.relay().connected) { W.disconnect(); paint(); return; }
      var v = input.value.trim();
      if (!W.validWallet(v)) {
        if (out) { out.className = 'w-status err'; out.textContent = v ? WALLET_HELP : 'Paste the address you trade from first.'; }
        input.focus();
        return;
      }
      W.setWallet(v);
      W.connect();
      paint();
    }

    btn.addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    input.addEventListener('input', function () { root.classList.toggle('filled', !!input.value.trim()); });
    W.on('relay', paint);
    paint();
    return { paint: paint, focus: function () { input.focus(); }, input: input };
  }
  window.YuiWallet = { bind: bindWallet };

  // ------------------------------------------------------------------ the steps
  // `done` is handed a `finish` callback and returns its own teardown. Nothing advances on a timer
  // except the greeting, which is the one step with no action to take.
  var STEPS = [
    {
      key: 'hello',
      eyebrow: 'Say hello',
      title: "I'm Yui",
      body: 'I live on your taskbar and react to your trades. This is the real me — the same code as the download, just running in your tab. Want the tour?',
      cta: 'Show me',
      manual: true,
      enter: function () { W.command('wave'); W.say("Hi! I'm Yui~", 4); },
    },
    {
      key: 'grab',
      eyebrow: 'Step 1 of 4',
      title: 'Pick me up',
      body: 'Click and hold me, then drag. Swing me around and let go — I flail, right myself in the air and land properly.',
      hint: 'Grab me anywhere. Try throwing me across the page.',
      halo: true,
      enter: function () { W.say('Grab me!', 3); },
      done: function (finish, setHint) {
        var got = false;
        var a = W.on('grab', function () { got = true; setHint('Got me — now sling me somewhere.'); });
        var b = W.on('throw', function () { finish(); });
        // Being put down gently counts too: the point is that she is a physical object, and
        // insisting on a hard throw strands anyone on a trackpad.
        var c = W.on('release', function () { if (got) setTimeout(finish, 700); });
        return function () { a(); b(); c(); };
      },
    },
    {
      key: 'panel',
      eyebrow: 'Step 2 of 4',
      title: 'Click me once',
      body: 'My settings open beside me — <b>Her</b>, <b>Look</b>, <b>Board</b>, <b>Wallet</b>. That is everything I can be told to do.',
      hint: 'A single click, not a drag.',
      halo: true,
      enter: function () { W.say('Click me~', 3); },
      done: function (finish) { return W.on('panel-open', finish); },
    },
    {
      key: 'dress',
      eyebrow: 'Step 3 of 4',
      title: 'Dress me up',
      body: 'Open the <b>Look</b> tab and change something — outfit, hair, the shape of me. It all applies live and it is all remembered in your browser.',
      hint: 'Look → pick an outfit, drag a slider, anything.',
      enter: function () {
        W.say('Make me cute~', 3);
        // If they closed everything on the way here, put the Look tab in front of them rather
        // than leaving the step with nothing to act on.
        if (!W.panelOpen()) W.openPanel('look');
      },
      done: function (finish, setHint) {
        var armed = false, t = setTimeout(function () { armed = true; }, 400); // ignore the tab switch itself
        var a = W.on('settings', function (patch) {
          if (!armed) return;
          for (var k in patch) if (k !== 'x' && k !== 'wallets') { finish(); return; }
        });
        var b = W.on('panel-tab', function (tab) { if (tab !== 'look') setHint('The Look tab — that is where I get changed.'); });
        // Her panel fills a phone screen. Leaving this step means the dressing is done, so put it
        // away rather than making the next step argue with it for the viewport.
        return function () { clearTimeout(t); a(); b(); W.closeAll(); };
      },
    },
    {
      key: 'wallet',
      eyebrow: 'Step 4 of 4',
      title: 'Give me an address',
      body: 'Paste the public address you buy from and I watch it live. I never connect a wallet, never ask you to sign, and cannot touch your funds.',
      wallet: true,
      skip: 'Show me without one',
      enter: function () { W.say('Whose bags am I watching?', 4); },
      done: function (finish) {
        return W.on('relay', function (r) { if (r.connected) finish(); });
      },
    },
    {
      key: 'done',
      eyebrow: 'That is everything',
      title: "You've got it",
      body: 'I glow when you win and bruise when you do not. Take me home for the real thing — on your taskbar I can see every wallet, and I stay up while you trade.',
      cta: 'Take her home',
      manual: true,
      ctaHref: '#get',
      enter: function () { W.command('wave'); W.say('See you on your desktop~', 4); },
    },
  ];

  // ------------------------------------------------------------------ the card
  var el = null, halo = null, i = -1, teardown = null, haloTimer = 0;

  function build() {
    el = document.createElement('aside');
    el.id = 'yui-tour';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);

    // A soft halo on the floor under her, so "me" is never ambiguous while she is wandering.
    halo = document.createElement('div');
    halo.id = 'yui-halo';
    halo.hidden = true;
    document.body.appendChild(halo);
    haloTimer = setInterval(followHalo, 60);
  }

  function followHalo() {
    if (!halo || halo.hidden) return;
    var info = W.info();
    if (!info) return;
    var r = Math.max(46, info.heightPx * 0.30);
    halo.style.width = halo.style.height = Math.round(r * 2) + 'px';
    halo.style.left = Math.round(info.screenX - r) + 'px';
    halo.style.top = Math.round(info.screenY - r * 0.62) + 'px';
  }

  // The greeting and the sign-off are not things to do, so the progress dots count the four
  // steps in between and nothing else.
  var ACTIONS = ['grab', 'panel', 'dress', 'wallet'];

  function render() {
    var s = STEPS[i];
    var pos = ACTIONS.indexOf(s.key);
    el.innerHTML =
      '<div class="t-top"><span class="t-eyebrow">' + s.eyebrow + '</span>'
      + '<button class="t-x" data-act="close" title="Close the tour">&times;</button></div>'
      + '<h3 class="t-title">' + s.title + '</h3>'
      + '<p class="t-body">' + s.body + '</p>'
      + (s.hint ? '<p class="t-hint" data-t="hint">' + s.hint + '</p>' : '')
      // data-w-root has to enclose the status line as well as the field: bindWallet scopes every
      // lookup to it, and a status element left outside would simply never be written to.
      + (s.wallet
        ? '<div data-w-root><div class="w-row">'
          + '<input data-w=addr type="text" spellcheck="false" autocomplete="off" placeholder="your Solana address">'
          + '<button data-w=go class="t-go">Watch it</button></div>'
          + '<div class="w-status" data-w=status></div></div>'
        : '')
      + '<div class="t-foot">'
      + '<div class="t-dots">' + ACTIONS.map(function (x, n) {
        return '<i class="' + (pos < 0 ? (s.key === 'done' ? 'on' : '') : n < pos ? 'on' : n === pos ? 'at' : '') + '"></i>';
      }).join('') + '</div>'
      + (s.cta
        ? '<a class="t-cta" ' + (s.ctaHref ? 'href="' + s.ctaHref + '"' : 'href="#" ') + ' data-act="next">' + s.cta + '</a>'
        : '<button class="t-skip" data-act="next">' + (s.skip || 'Skip') + '</button>')
      + '</div>';

    el.className = 'show' + (s.wallet ? ' wide' : '');
    halo.hidden = !s.halo;
    if (s.halo) followHalo();
    fit();

    var root = $('[data-w-root]', el);
    if (root) {
      var w = bindWallet(root);
      // Only autofocus on a pointer device: a phone keyboard springing up would hide her.
      if (w && window.matchMedia('(hover: hover)').matches) setTimeout(w.focus, 120);
    }

    el.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var act = b.dataset.act;
        if (act === 'close') { e.preventDefault(); stop(); return; }
        if (s.ctaHref) { stop(); return; }        // a real link: let it navigate
        e.preventDefault();
        next();
      });
    });
  }

  // A phone has no free corner: she stands at the bottom and the card has to go up top, where it
  // would cover the headline. So the hero is told how much room the card is taking and moves its
  // own content down by exactly that much, for as long as the tour is running.
  function fit() {
    var narrow = window.innerWidth <= 720 && el && el.classList.contains('show');
    document.documentElement.style.setProperty('--tour-h', narrow ? el.offsetHeight + 'px' : '0px');
  }
  window.addEventListener('resize', fit);

  function setHint(text) {
    var h = $('[data-t=hint]', el);
    if (h) { h.textContent = text; h.classList.add('bump'); setTimeout(function () { h.classList.remove('bump'); }, 400); }
  }

  function go(n) {
    if (teardown) { teardown(); teardown = null; }
    i = n;
    if (i >= STEPS.length) { stop(); return; }
    render();
    var s = STEPS[i];
    if (s.enter) s.enter();
    if (s.done) {
      var settled = false;
      teardown = s.done(function () {
        if (settled) return;
        settled = true;
        celebrate();
        setTimeout(function () { if (i === n) next(); }, 900);
      }, setHint);
    }
  }
  function next() { go(i + 1); }

  function celebrate() {
    el.classList.add('ok');
    setTimeout(function () { el.classList.remove('ok'); }, 900);
  }

  function stop() {
    if (teardown) { teardown(); teardown = null; }
    if (el) { el.className = ''; }
    if (halo) halo.hidden = true;
    fit();
    try { localStorage.setItem(SEEN, '1'); } catch (e) {}
    document.documentElement.classList.remove('yui-touring');
    i = -1;
  }

  function start() {
    if (!el) build();
    document.documentElement.classList.add('yui-touring');
    go(0);
  }

  window.YuiGuide = {
    start: start,
    stop: stop,
    running: function () { return i >= 0; },
    seen: function () { try { return localStorage.getItem(SEEN) === '1'; } catch (e) { return false; } },
    // Called once she is on screen. A returning visitor gets the wave and nothing else.
    auto: function () {
      if (window.YuiGuide.seen()) { W.command('wave'); W.say('Welcome back~', 3); return; }
      setTimeout(start, 700);
    },
  };
})();
