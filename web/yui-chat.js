// Talking to Yui.
//
// A bar at the bottom of the page: type a line, or switch the mic on and speak. The line goes to
// the site's own server (server/yui-chat.js), which asks Claude and has ElevenLabs read the answer
// in her voice. The answer comes back in spoken pieces; each one plays through the renderer
// (window.__petSpeak, so her mouth moves and her volume applies) with its words in her bubble.
//
// With the mic on it is a conversation: she listens, answers out loud, then listens again. She
// does not listen while she is speaking, so she never hears herself.
//
// The desktop app loads this same file. There the line goes to the app's main process instead
// (src/desktop-chat.js, over window.pet.chat) and runs on the keys of whoever runs her: with none
// saved yet, a card asks for them once she is on screen. The bar follows her along the taskbar.
(function () {
  'use strict';
  var API = '/api/yui/';
  var DESK = !!(window.pet && window.pet.chat);   // inside the desktop app
  var status = { chat: false, voice: false };
  var MAX = 600;                 // the server's cap on one line
  var history = [];              // [{role, content}] — this visit only, never stored
  var queue = [];                // spoken pieces waiting their turn: {text, id}
  var playing = null;            // the audio element speaking now
  var gapTimer = 0;              // a text-only piece holds the bubble for this long
  var waiting = null;            // the piece whose audio is still on its way
  var streaming = null;          // AbortController of the answer on its way
  var micOn = false, hearing = false;
  var bar, input, micBtn, sendBtn, card = null;

  var css = ''
    + '#yui-chat{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:46;display:none;align-items:center;gap:6px;'
    + 'width:min(480px,calc(100vw - 24px));box-sizing:border-box;padding:6px;border-radius:18px;background:rgba(13,11,18,.86);'
    + 'border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 44px rgba(0,0,0,.45),0 0 0 1px rgba(180,140,255,.06) inset;'
    + '-webkit-backdrop-filter:blur(14px) saturate(1.3);backdrop-filter:blur(14px) saturate(1.3);transition:border-color .2s,box-shadow .2s}'
    + 'html.yui-ready #yui-chat{display:flex}'
    + 'html.yui-starter #yui-chat,html.yui-intro #yui-chat{display:none}'
    + '#yui-chat:focus-within{border-color:rgba(255,111,174,.55);box-shadow:0 14px 44px rgba(0,0,0,.45),0 0 0 4px rgba(255,111,174,.10)}'
    + '#yui-chat input{flex:1;min-width:0;height:42px;padding:0 12px;border:0;outline:0;background:transparent;color:#f1edf8;'
    + 'font:500 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + '#yui-chat input::placeholder{color:#8f879f}'
    + '#yui-chat button{flex:none;width:42px;height:42px;display:grid;place-items:center;border:0;border-radius:13px;cursor:pointer;'
    + 'background:rgba(255,255,255,.06);color:#e8e4f0;transition:background .15s,transform .15s,box-shadow .15s}'
    + '#yui-chat button:hover{background:rgba(255,255,255,.12)}'
    + '#yui-chat button:active{transform:scale(.94)}'
    + '#yui-chat button svg{width:19px;height:19px;fill:currentColor}'
    + '#yui-chat .send{background:linear-gradient(135deg,#ff6fae,#b48cff);color:#fff}'
    + '#yui-chat .send:hover{background:linear-gradient(135deg,#ff84ba,#c19fff)}'
    + '#yui-chat .mic.on{background:rgba(255,111,174,.2);color:#ff8fc0;box-shadow:0 0 0 1px rgba(255,111,174,.5) inset}'
    + '#yui-chat .mic.hear{animation:yuiHear 1.1s ease-in-out infinite}'
    + '#yui-chat.busy .send{opacity:.55}'
    + '@keyframes yuiHear{0%,100%{box-shadow:0 0 0 1px rgba(255,111,174,.5) inset,0 0 0 0 rgba(255,111,174,.45)}50%{box-shadow:0 0 0 1px rgba(255,111,174,.5) inset,0 0 0 7px rgba(255,111,174,0)}}'
    + '#yui-chat.desk{display:none;z-index:9;bottom:12px;width:400px;transition:left .45s cubic-bezier(.3,.9,.3,1),border-color .2s,box-shadow .2s}'
    + '#yui-chat.desk.on{display:flex}'
    + '#yui-chat .hide{width:26px;height:26px;border-radius:9px;background:transparent;color:#8f879f;font:600 15px/1 system-ui,sans-serif}'
    + '#yui-key{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:12;width:min(430px,calc(100vw - 32px));box-sizing:border-box;'
    + 'padding:26px 26px 22px;border-radius:24px;border:1px solid transparent;color:#f1edf8;font:400 14.5px/1.55 "Rubik","Segoe UI",system-ui,sans-serif;'
    + 'background:radial-gradient(260px 160px at 92% -8%,rgba(255,111,174,.30),transparent 72%) padding-box,radial-gradient(220px 150px at -6% 108%,rgba(124,92,255,.30),transparent 72%) padding-box,'
    + 'linear-gradient(rgba(13,11,18,.97),rgba(13,11,18,.97)) padding-box,linear-gradient(135deg,#ff6fae,#7c5cff) border-box;'
    + 'box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 40px rgba(255,111,174,.14);animation:yuiKeyIn .35s cubic-bezier(.3,1.4,.4,1)}'
    + '@keyframes yuiKeyIn{from{opacity:0;transform:translate(-50%,-46%) scale(.94)}}'
    + '#yui-key h3{margin:0 0 6px;font:700 22px/1.2 "Outfit","Rubik","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em}'
    + '#yui-key p{margin:0 0 16px;color:#b3a8c9}'
    + '#yui-key label{display:block;margin:12px 0 6px;font:600 11px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#ff9cc8}'
    + '#yui-key label i{font-style:normal;color:#8f879f;letter-spacing:.04em;text-transform:none;font-weight:500;margin-left:6px}'
    + '#yui-key input{width:100%;box-sizing:border-box;height:44px;padding:0 13px;border-radius:13px;border:1px solid rgba(255,255,255,.16);outline:0;'
    + 'background:rgba(255,255,255,.05);color:#f1edf8;font:500 14px/1 ui-monospace,Consolas,monospace;transition:border-color .15s,box-shadow .15s}'
    + '#yui-key input:focus{border-color:#ff6fae;box-shadow:0 0 0 3px rgba(255,111,174,.16)}'
    + '#yui-key input.bad{border-color:#ff5c8a}'
    + '#yui-key a{display:inline-block;margin-top:6px;color:#b9a2ff;font-size:12.5px;text-decoration:none;cursor:pointer}'
    + '#yui-key a:hover{color:#d6c8ff;text-decoration:underline}'
    + '#yui-key .err{min-height:20px;margin:12px 0 0;color:#ff7fa5;font-size:13px}'
    + '#yui-key .row{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}'
    + '#yui-key button{height:42px;padding:0 20px;border-radius:13px;border:0;cursor:pointer;font:600 14.5px/1 "Rubik","Segoe UI",system-ui,sans-serif;'
    + 'background:rgba(255,255,255,.07);color:#e8e4f0;transition:background .15s,opacity .15s}'
    + '#yui-key button:hover{background:rgba(255,255,255,.13)}'
    + '#yui-key button.go{background:linear-gradient(135deg,#ff6fae,#7c5cff);color:#fff}'
    + '#yui-key button[disabled]{opacity:.55;cursor:default}'
    + '@media (max-width:700px){#yui-chat{left:10px;right:112px;bottom:10px;width:auto;transform:none}#yui-chat input{font-size:16px}}';

  var ICON_MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15zm6.2-3.5a1 1 0 0 0-2 0 4.2 4.2 0 0 1-8.4 0 1 1 0 0 0-2 0 6.2 6.2 0 0 0 5.2 6.1V20H9a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-2v-2.4a6.2 6.2 0 0 0 5.2-6.1z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4 21 12.9a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.2L4.3 11l9.2 1-9.2 1L2 19.2a1 1 0 0 0 1.4 1.2z"/></svg>';

  function bubble(text, secs) { if (window.__petSay) window.__petSay(text, secs, 0); }
  function setBusy(on) {
    bar.classList.toggle('busy', on);
    input.placeholder = on ? 'Yui is thinking…' : micOn ? 'Listening… just speak' : 'Say something to Yui…';
  }

  // ---- where a line goes -----------------------------------------------------------------------
  // chat(body, signal, onEvent) resolves when the answer is complete; onEvent gets
  // {t:'say', text, audio: Promise<url|null>} for each spoken piece and {t:'err', msg}.
  var WEB = {
    status: function () { return fetch(API + 'status').then(function (r) { return r.ok ? r.json() : null; }); },
    chat: function (body, signal, onEvent) {
      return fetch(API + 'chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: signal, body: JSON.stringify(body) }).then(function (r) {
        if (!r.ok || !r.body) { onEvent({ t: 'err', msg: r.status === 429 ? 'slow' : 'failed' }); return; }
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
        var step = function () {
          return reader.read().then(function (x) {
            if (x.done) return;
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              var line = buf.slice(0, i); buf = buf.slice(i + 2);
              if (line.indexOf('data: ') !== 0) continue;
              var m; try { m = JSON.parse(line.slice(6)); } catch (e) { continue; }
              if (m.t === 'say') m.audio = Promise.resolve(m.id ? API + 'audio/' + m.id : null);
              onEvent(m);
            }
            return step();
          });
        };
        return step();
      });
    },
    stt: function (blob) { return fetch(API + 'stt', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob }).then(function (x) { return x.ok ? x.json() : { text: '' }; }); },
  };
  var deskLive = {}, deskSeq = 0;
  var DESKTOP = DESK && {
    status: function () { return window.pet.chat.status(); },
    chat: function (body, signal, onEvent) {
      return new Promise(function (resolve) {
        var id = 'c' + (++deskSeq) + '-' + Date.now(), audio = {};
        deskLive[id] = function (m) {
          if (m.t === 'say') {
            m.audio = !m.voiced ? Promise.resolve(null) : new Promise(function (res) { audio[m.n] = res; setTimeout(function () { res(null); }, 15000); });
            onEvent(m);
          } else if (m.t === 'audio') { if (audio[m.n]) audio[m.n](m.buf ? URL.createObjectURL(new Blob([m.buf], { type: 'audio/mpeg' })) : null); }
          else if (m.t === 'err') onEvent(m);
          else if (m.t === 'done') { delete deskLive[id]; resolve(); }
        };
        signal.addEventListener('abort', function () { window.pet.chat.abort(id); });
        window.pet.chat.send(id, body);
      });
    },
    stt: function (blob) { return blob.arrayBuffer().then(function (buf) { return window.pet.chat.stt(buf, blob.type || 'audio/webm'); }); },
  };
  if (DESK) window.pet.chat.onEvent(function (m) { var h = deskLive[m.id]; if (h) h(m); });
  var T = DESKTOP || WEB;
  var SORRY = {
    slow: 'Phew, let me catch my breath for a minute~', busy: 'So many people talking to me… one sec~',
    credit: 'My Claude key is out of credit… top it up and I can think again~', failed: "My head's all fuzzy… try me again?",
  };

  // ---- her answer, out loud ---------------------------------------------------------------------
  function quietNow() { return !playing && !gapTimer && !waiting && !queue.length && !streaming; }
  function hush() {
    queue.length = 0; waiting = null;
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = 0; }
    if (playing) { var a = playing; playing = null; a.onended = a.onerror = null; try { a.pause(); } catch (e) {} }
  }
  function pump() {
    if (playing || gapTimer || waiting) return;
    var p = queue.shift();
    if (!p) { if (quietNow()) listen(); return; }
    waiting = p;
    p.audio.then(function (url) { if (waiting === p) { waiting = null; play(p, url); } });
  }
  function play(p, url) {
    var next = function () { playing = null; gapTimer = 0; if (url && url.indexOf('blob:') === 0) URL.revokeObjectURL(url); pump(); };
    var readTime = Math.min(9000, 1400 + p.text.length * 60);
    var textOnly = function () { playing = null; bubble(p.text, readTime / 1000); gapTimer = setTimeout(next, readTime); };
    if (!url || !window.__petSpeak) { textOnly(); return; }
    var a = window.__petSpeak(url), shown = false;
    playing = a;
    // the words appear as her voice starts, and stay up until the piece has been spoken
    a.onplaying = function () { if (!shown) { shown = true; bubble(p.text, Math.max(readTime / 1000, (a.duration && isFinite(a.duration) ? a.duration : 0) + 0.6)); } };
    a.onended = function () { if (playing === a) next(); };
    a.onerror = function () { if (playing === a) { if (shown) next(); else textOnly(); } };
    var pr = a.play();
    if (pr && pr.catch) pr.catch(function () { if (playing === a && !shown) textOnly(); });
  }

  function send(text) {
    text = String(text || '').trim().slice(0, MAX);
    if (!text) return;
    if (DESK && !status.chat) { askKeys(); return; }
    // a new line while she is still answering: she stops and takes the new one
    if (streaming) { try { streaming.abort(); } catch (e) {} streaming = null; }
    hush(); stopHearing();
    history.push({ role: 'user', content: text });
    if (history.length > 20) history.splice(0, history.length - 20);
    input.value = '';
    setBusy(true);
    var ctl = streaming = new AbortController(), said = [];
    var s = window.__petSession ? window.__petSession() : null;
    var finish = function () {
      if (said.length) history.push({ role: 'assistant', content: said.join(' ') });
      if (streaming === ctl) { streaming = null; setBusy(false); if (quietNow()) listen(); }
    };
    T.chat({ messages: history, ctx: s ? { pnl: s.pnl, trades: s.trades } : null }, ctl.signal, function (m) {
      if (streaming !== ctl) return;
      if (m.t === 'say') { said.push(m.text); queue.push({ text: m.text, audio: m.audio }); setBusy(false); pump(); }
      else if (m.t === 'err' && m.msg === 'key') { status.chat = false; askKeys('That Claude key stopped working. Paste a new one.'); }
      else if (m.t === 'err' && !said.length) bubble(SORRY[m.msg] || SORRY.failed, 5);
    }).catch(function (e) {
      if (streaming === ctl && !(e && e.name === 'AbortError')) bubble("I can't reach my brain right now… try again?", 4);
    }).then(finish);
  }

  // ---- her ears -----------------------------------------------------------------------------------
  // The browser's own speech recognition where it exists (live words as you speak); otherwise the
  // page records until you stop talking and the server transcribes it.
  var SR = DESK ? null : window.SpeechRecognition || window.webkitSpeechRecognition;   // the app's Chromium has no recognition service
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var rec = null, recStream = null, recorder = null, recCtx = null, recRaf = 0;

  function micLook() { micBtn.classList.toggle('on', micOn); micBtn.classList.toggle('hear', micOn && hearing); setBusy(bar.classList.contains('busy')); }
  function micDenied() { micOn = false; hearing = false; micLook(); bubble("I can't hear you… allow the microphone for this page~", 5); }
  function listen() {
    if (!micOn || hearing || !quietNow()) return;
    if (SR) listenSR(); else listenRecord();
  }
  function stopHearing() {
    hearing = false;
    if (rec) { try { rec.abort(); } catch (e) {} }
    if (recorder) { var r = recorder; recorder = null; r.onstop = null; try { r.stop(); } catch (e) {} }
    if (recRaf) { cancelAnimationFrame(recRaf); recRaf = 0; }
    micLook();
  }
  function listenSR() {
    if (!rec) {
      rec = new SR();
      rec.continuous = false; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
      rec.onresult = function (e) {
        var text = '', fin = false;
        for (var i = 0; i < e.results.length; i++) { text += e.results[i][0].transcript; if (e.results[i].isFinal) fin = true; }
        input.value = text;
        if (fin && text.trim()) send(text);
      };
      rec.onerror = function (e) { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') micDenied(); };
      // recognition ends after every phrase and every silence: while the mic is on, she listens again
      rec.onend = function () { hearing = false; micLook(); if (micOn) setTimeout(listen, 250); };
    }
    try { rec.start(); hearing = true; micLook(); } catch (e) { /* already started */ }
  }
  function listenRecord() {
    var begin = function () {
      var chunks = [], r;
      try { r = new MediaRecorder(recStream); } catch (e) { micDenied(); return; }
      recorder = r; hearing = true; micLook();
      r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      r.onstop = function () {
        recorder = null; hearing = false; micLook();
        if (recRaf) { cancelAnimationFrame(recRaf); recRaf = 0; }
        if (!heard) { if (micOn) setTimeout(listen, 250); return; }
        setBusy(true);
        T.stt(new Blob(chunks, { type: r.mimeType || 'audio/webm' }))
          .then(function (d) { setBusy(false); if (d.text) send(d.text); else if (micOn) listen(); })
          .catch(function () { setBusy(false); if (micOn) listen(); });
      };
      // stop by ear: once something was said, 1.2 s of quiet ends the phrase (20 s at most)
      var an = recCtx.createAnalyser(); an.fftSize = 512;
      recCtx.createMediaStreamSource(recStream).connect(an);
      var data = new Uint8Array(an.fftSize), heard = false, quietSince = 0, t0 = performance.now();
      var watch = function () {
        if (recorder !== r) return;
        an.getByteTimeDomainData(data);
        var sum = 0; for (var i = 0; i < data.length; i++) { var v = (data[i] - 128) / 128; sum += v * v; }
        var loud = Math.sqrt(sum / data.length) > 0.035, now = performance.now();
        if (loud) { heard = true; quietSince = 0; } else if (!quietSince) quietSince = now;
        if ((heard && quietSince && now - quietSince > 1200) || now - t0 > 20000 || (!heard && now - t0 > 8000)) { try { r.stop(); } catch (e) {} return; }
        recRaf = requestAnimationFrame(watch);
      };
      r.start(); watch();
    };
    if (recStream) { begin(); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (s) {
      recStream = s; recCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (micOn) begin();
    }).catch(micDenied);
  }
  function toggleMic() {
    micOn = !micOn;
    if (micOn) { micLook(); listen(); }
    else {
      stopHearing();
      if (recStream) { recStream.getTracks().forEach(function (t) { t.stop(); }); recStream = null; if (recCtx) { try { recCtx.close(); } catch (e) {} recCtx = null; } }
    }
  }

  // ---- the keys (desktop) ------------------------------------------------------------------------
  // The app ships with no keys: she asks for them once, keeps them on this PC, and asks again only
  // if one stops working. Her right-click menu opens the same card.
  function field(labelText, hint, ph) {
    var l = document.createElement('label'); l.textContent = labelText;
    if (hint) { var i = document.createElement('i'); i.textContent = hint; l.appendChild(i); }
    var inp = document.createElement('input'); inp.type = 'password'; inp.placeholder = ph; inp.spellcheck = false; inp.autocomplete = 'off';
    inp.addEventListener('keydown', function (e) { e.stopPropagation(); });
    inp.addEventListener('contextmenu', function (e) { e.preventDefault(); window.pet.editMenu(); });
    return { label: l, input: inp };
  }
  function link(text, url) {
    var a = document.createElement('a'); a.textContent = text;
    a.addEventListener('click', function () { window.pet.openExternal(url); });
    return a;
  }
  function closeKeys() { if (card) { card.remove(); card = null; } }
  function askKeys(msg) {
    if (!DESK || card) return;
    card = document.createElement('form'); card.id = 'yui-key'; card.className = 'yui-ui';
    var h = document.createElement('h3'); h.textContent = status.chat ? "Yui's keys" : 'Wake Yui up';
    var p = document.createElement('p'); p.textContent = 'Yui thinks with Claude and speaks with ElevenLabs. Paste your API keys and she will talk with you. They stay on this PC.';
    var a = field('Claude API key', status.chat ? 'saved — leave empty to keep it' : '', 'sk-ant-…');
    var x = field('ElevenLabs API key', status.voice ? 'saved — leave empty to keep it' : 'optional: her voice and your mic', 'sk_…');
    var err = document.createElement('div'); err.className = 'err'; err.textContent = msg || '';
    var row = document.createElement('div'); row.className = 'row';
    var later = document.createElement('button'); later.type = 'button'; later.textContent = 'Later';
    var go = document.createElement('button'); go.type = 'submit'; go.className = 'go'; go.textContent = 'Save';
    row.appendChild(later); row.appendChild(go);
    [h, p, a.label, a.input, link('Get a Claude key →', 'https://console.anthropic.com/settings/keys'),
      x.label, x.input, link('Get an ElevenLabs key →', 'https://elevenlabs.io/app/settings/api-keys'), err, row].forEach(function (n) { card.appendChild(n); });
    document.body.appendChild(card);
    setTimeout(function () { a.input.focus(); }, 60);
    later.addEventListener('click', closeKeys);
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      var k = {}, av = a.input.value.trim(), xv = x.input.value.trim();
      if (av) k.anthropic = av;
      if (xv) k.eleven = xv;
      a.input.classList.remove('bad'); x.input.classList.remove('bad');
      if (!av && !status.chat) { a.input.classList.add('bad'); err.textContent = 'She needs a Claude key to think.'; return; }
      if (!av && !xv) { closeKeys(); return; }
      go.disabled = true; go.textContent = 'Checking…'; err.textContent = '';
      window.pet.chat.setKeys(k).then(function (r) {
        if (!card) return;
        if (!r || !r.ok) {
          go.disabled = false; go.textContent = 'Save';
          err.textContent = (r && r.error) || 'That did not work. Try again.';
          (r && r.field === 'eleven' ? x : a).input.classList.add('bad');
          return;
        }
        var first = !status.chat;
        status = { chat: r.chat, voice: r.voice };
        micBtn.style.display = status.voice && canRecord ? '' : 'none';
        closeKeys(); showBar(true);
        if (first) send('Hi Yui!'); else bubble('Got it~', 2.5);
      });
    });
  }

  // ---- the bar ------------------------------------------------------------------------------------
  function showBar(on) {
    if (!DESK) return;
    bar.classList.toggle('on', on);
    if (!on) { if (micOn) toggleMic(); input.blur(); }
  }
  function build() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    bar = document.createElement('form'); bar.id = 'yui-chat'; bar.className = 'yui-ui' + (DESK ? ' desk' : ''); bar.autocomplete = 'off';
    input = document.createElement('input');
    input.type = 'text'; input.maxLength = MAX; input.spellcheck = false; input.enterKeyHint = 'send';
    input.setAttribute('aria-label', 'Talk to Yui');
    micBtn = document.createElement('button'); micBtn.type = 'button'; micBtn.className = 'mic'; micBtn.title = 'Talk with your microphone'; micBtn.innerHTML = ICON_MIC;
    sendBtn = document.createElement('button'); sendBtn.type = 'submit'; sendBtn.className = 'send'; sendBtn.title = 'Send'; sendBtn.innerHTML = ICON_SEND;
    if (DESK) {
      var hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide'; hide.title = 'Hide (right-click her to bring it back)'; hide.textContent = '×';
      hide.addEventListener('click', function () { showBar(false); window.pet.saveSettings({ chatHidden: true }); });
      bar.appendChild(hide);
    }
    bar.appendChild(input);
    if (SR || canRecord) bar.appendChild(micBtn);
    if (DESK && !status.voice) micBtn.style.display = 'none';
    bar.appendChild(sendBtn);
    document.body.appendChild(bar);
    setBusy(false);
    bar.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
    micBtn.addEventListener('click', toggleMic);
    // typing belongs to the bar: page shortcuts and her own key handling stay out of it
    input.addEventListener('keydown', function (e) { if (e.key !== 'Escape') e.stopPropagation(); else input.blur(); });
    if (DESK) desk();
  }

  // On the desktop the bar stands at her feet and follows her along the taskbar. It holds still
  // while it is being used, so it never slides out from under the cursor.
  function desk() {
    var hidden = false, shown = false, asked = false, lastMove = 0;
    input.addEventListener('contextmenu', function (e) { e.preventDefault(); window.pet.editMenu(); });
    window.pet.onSettings(function (s) { hidden = !!(s && s.chatHidden); });
    window.pet.onCommand(function (c) {
      if (c === 'talk') { hidden = false; window.pet.saveSettings({ chatHidden: false }); showBar(true); shown = true; input.focus(); if (!status.chat) askKeys(); }
      else if (c === 'keys') askKeys();
    });
    var tour = document.getElementById('tour');
    var follow = function (now) {
      requestAnimationFrame(follow);
      if (now - lastMove < 140) return;
      lastMove = now;
      var ready = window.__petModel && window.__petModel() && (!tour || tour.hidden);
      if (!ready) return;
      if (!shown && !hidden) { shown = true; showBar(true); }
      // the first time she is on screen with no key, she asks for one
      if (!asked) { asked = true; if (!status.chat) askKeys(); }
      if (!bar.classList.contains('on') || bar.matches(':hover') || bar.contains(document.activeElement)) return;
      var p = window.__petBonePx && window.__petBonePx('hips');
      if (!p || !isFinite(p.x)) return;
      var half = bar.offsetWidth / 2 + 8;
      bar.style.left = Math.max(half, Math.min(window.innerWidth - half, p.x)) + 'px';
    };
    requestAnimationFrame(follow);
  }

  window.YuiChat = {
    send: function (t) { if (bar) send(t); },
    focus: function () { if (!bar) return; input.focus(); if (!history.length && quietNow()) send('Hi Yui!'); },
    keys: askKeys,
  };

  T.status().then(function (s) {
    if (!s || (!s.chat && !DESK)) return;
    status = { chat: !!s.chat, voice: !!s.voice };
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
  }).catch(function () {});
})();
