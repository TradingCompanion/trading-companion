// Her toolbar popup: the one field that matters (the wallet), a switch per site, a frame cap, and
// what she is doing on the current tab. It talks to the tab's content script for status and writes
// settings to chrome.storage, which every tab is watching.
'use strict';
const STORE = 'yui.web.settings.v2';
const EXT = 'yui.ext';
const $ = (id) => document.getElementById(id);
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let tab = null, mem = {};
function prefs() { let p = {}; try { p = JSON.parse(mem[EXT] || '{}') || {}; } catch { p = {}; } if (!p.off) p.off = {}; return p; }
function settings() { let s = {}; try { s = JSON.parse(mem[STORE] || '{}') || {}; } catch { s = {}; } return s; }
function host() { try { return tab && tab.url ? new URL(tab.url).hostname : ''; } catch { return ''; } }

function ask(type, extra) {
  return new Promise((res) => {
    if (!tab) return res(null);
    try { chrome.tabs.sendMessage(tab.id, Object.assign({ type }, extra || {}), (r) => { void chrome.runtime.lastError; res(r || null); }); } catch { res(null); }
  });
}

function showStatus(st) {
  const el = $('status');
  el.className = 'status';
  $('open').disabled = !(st && st.shown && st.ready);
  if (!st) { el.textContent = 'She is not on this page.'; $('nothere').style.display = 'block'; $('siteRows').style.display = 'none'; return; }
  $('nothere').style.display = 'none'; $('siteRows').style.display = '';
  $('host').textContent = st.host || host();
  $('onHere').checked = !!st.shown || !prefs().off[st.host];
  if (!st.shown) { el.textContent = 'Hidden on ' + st.host + '.'; return; }
  if (!st.ready) { el.classList.add('wait'); el.textContent = 'Loading her…'; return; }
  const r = st.relay || {};
  if (!st.wallet) { el.classList.add('warn'); el.textContent = 'No wallet yet — paste one above.'; return; }
  if (r.connected) { el.classList.add('ok'); el.textContent = 'Watching · ' + (r.trades || 0) + ' trade' + (r.trades === 1 ? '' : 's') + ' seen' + (st.socket === 'background' ? '' : ' · page socket'); return; }
  if (r.status === 'connecting') { el.classList.add('wait'); el.textContent = r.info || 'Connecting…'; return; }
  el.classList.add(r.status === 'err' ? 'err' : 'warn'); el.textContent = r.info || 'Not connected.';
}

async function refresh() { showStatus(await ask('status')); }

async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  mem = await new Promise((res) => chrome.storage.local.get([STORE, EXT], (v) => res(v || {})));
  [tab] = await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, res));
  $('wallet').value = String(settings().wallets || '');
  $('fps').value = String(prefs().fps === 30 ? 30 : 0);
  await refresh();
  setInterval(refresh, 1500);

  $('wallet').addEventListener('input', () => {
    const ws = $('wallet').value.trim().split(/[\s,]+/).filter(Boolean);
    $('wallet').classList.toggle('bad', ws.some((w) => !WALLET.test(w)));
  });
  $('save').addEventListener('click', async () => {
    const ws = $('wallet').value.trim().split(/[\s,]+/).filter(Boolean);
    if (ws.some((w) => !WALLET.test(w))) { $('wallet').classList.add('bad'); $('wallet').focus(); return; }
    const s = settings(); s.wallets = ws.join(' ');
    mem[STORE] = JSON.stringify(s);
    await new Promise((res) => chrome.storage.local.set({ [STORE]: mem[STORE] }, res));
    $('save').textContent = 'Saved'; setTimeout(() => { $('save').textContent = 'Save'; }, 1200);
    setTimeout(refresh, 400);
  });
  const savePrefs = async (p) => { mem[EXT] = JSON.stringify(p); await new Promise((res) => chrome.storage.local.set({ [EXT]: mem[EXT] }, res)); setTimeout(refresh, 300); };
  $('onHere').addEventListener('change', () => { const p = prefs(), h = host(); if (!h) return; if ($('onHere').checked) delete p.off[h]; else p.off[h] = true; savePrefs(p); });
  $('fps').addEventListener('change', () => { const p = prefs(); p.fps = Number($('fps').value) === 30 ? 30 : 0; savePrefs(p); });
  $('open').addEventListener('click', async () => { await ask('open-panel', { tab: 'wallet' }); window.close(); });
}
init();
