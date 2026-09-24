// The page's "watch an address" box.
//
// The same wallet as the one in her panel: this binds the page's own input and button to
// YuiWeb's wallet and relay calls, so the section and the panel can never disagree about what is
// watched or whether she is connected. (It used to live in the page's walkthrough; the app's own
// tour replaced that, and this is the part that stayed.)
(function () {
  'use strict';

  var W = window.YuiWeb;
  var $ = function (s, r) { return (r || document).querySelector(s); };

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
})();
