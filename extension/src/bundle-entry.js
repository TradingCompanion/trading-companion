// The extension's copy of Yui: the website's bridge and the app's renderer, bundled together but
// not started. The content script (content.js) has to read chrome.storage and build her shadow
// root first, and only then calls YuiExt.boot() — so both files are required lazily, in the order
// the website loads them: the bridge defines window.pet, the renderer reads it.
//
// esbuild bundles this with three defines that make the same renderer run inside a shadow root
// on a page that is not ours (see scripts/build-extension.js): `document` becomes the content
// script's stand-in that answers getElementById / body from her shadow root, `WebSocket` becomes
// a socket opened by the extension's background worker (no mixed-content rule there), and
// `requestAnimationFrame` gains a frame cap and a pause switch.
'use strict';
window.YuiExt = {
  boot: function () {
    require('../../web/yui-boot.js');
    require('../../src/renderer.js');
  },
};
