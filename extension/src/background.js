// Yui's background worker: it holds her relay sockets.
//
// Every trading site is https, and an https page may only open wss://. The relay is plain ws://,
// and even once it has TLS a socket per tab would run into the relay's per-address cap the moment
// a trader has a few terminals open. So the sockets live here instead: one per relay URL (the URL
// carries the wallets, so tabs watching the same wallets share one connection), fanned out to
// every tab through a runtime port. The renderer never knows — content.js hands it a WebSocket
// look-alike whose messages come over that port.
//
// Keep-alive: Chrome ends an idle worker after 30 s, but relay traffic (a heartbeat every 25 s)
// and the tabs' port pings both count as activity, so the sockets stay up while any tab is open.
'use strict';

const shared = new Map();   // relay URL -> { url, ws, ports:Set<Port>, open, hello, errored }

function post(port, m) { try { port.postMessage(m); } catch { /* the tab went away */ } }
function broadcast(e, m) { for (const p of e.ports) post(p, m); }

function connect(e, url) {
  let ws;
  try { ws = new WebSocket(url); } catch (err) {
    broadcast(e, { type: 'error' });
    broadcast(e, { type: 'close', code: 1006, reason: String(err && err.message || err) });
    shared.delete(e.url); e.ports.clear();
    return;
  }
  e.ws = ws; e.open = false; e.errored = false;
  ws.onopen = () => { e.open = true; broadcast(e, { type: 'open' }); };
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : '';
    if (!data) return;
    // The relay opens with a hello that carries the open positions. A tab joining an already-open
    // socket gets the same greeting, so its cost basis is seeded like the first tab's was.
    if (data.indexOf('"type":"hello"') !== -1) e.hello = data;
    broadcast(e, { type: 'message', data });
  };
  ws.onerror = () => { e.errored = true; };
  ws.onclose = (ev) => {
    if (e.ws !== ws) return;
    if (e.errored && !e.open) broadcast(e, { type: 'error' });
    broadcast(e, { type: 'close', code: ev.code, reason: ev.reason || '' });
    shared.delete(e.url); e.ports.clear(); e.ws = null;
  };
}

function join(url, port) {
  let e = shared.get(url);
  if (!e) {
    e = { url, ws: null, ports: new Set(), open: false, hello: null, errored: false };
    shared.set(url, e);
    connect(e, url);
  }
  e.ports.add(port);
  if (e.open) {
    post(port, { type: 'open' });
    if (e.hello) post(port, { type: 'message', data: e.hello });
  }
  return e;
}

function leave(e, port) {
  if (!e) return;
  e.ports.delete(port);
  if (e.ports.size) return;
  shared.delete(e.url);
  const ws = e.ws; e.ws = null;
  if (ws) try { ws.close(); } catch { /* already gone */ }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'yui-relay') return;
  let entry = null;
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'open' && typeof m.url === 'string' && !entry) entry = join(m.url, port);
    else if (m.type === 'send' && entry && entry.ws && entry.ws.readyState === 1) entry.ws.send(String(m.data));
    else if (m.type === 'close') { leave(entry, port); entry = null; post(port, { type: 'close', code: 1000, reason: '' }); }
    else if (m.type === 'ping') post(port, { type: 'pong' });
  });
  port.onDisconnect.addListener(() => { leave(entry, port); entry = null; });
});

// A tab asks for the share count now and then (the popup shows it).
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m && m.type === 'relay-sockets') { reply({ sockets: shared.size, tabs: [...shared.values()].reduce((n, e) => n + e.ports.size, 0) }); }
  return false;
});
