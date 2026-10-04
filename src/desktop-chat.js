// Talking to Yui in the desktop app (main process; bundled to dist/chat.js).
//
// The app ships with no keys. Whoever runs her pastes their own: a Claude key so she can think,
// and optionally an ElevenLabs key so she can speak and hear. Both stay on this machine, in the
// app's data folder, encrypted with the operating system's own store where there is one, and are
// sent nowhere but to Anthropic and ElevenLabs themselves. The page never gets them back.
'use strict';
const fs = require('fs');
const path = require('path');
const brain = require('./yui-brain.js');

function init({ app, ipcMain, safeStorage, send }) {
  const file = () => path.join(app.getPath('userData'), 'keys.json');
  let keys = null, client = null;
  const voiceState = { voice: 0 };
  const live = new Map();      // conversation id -> { stream, gone }

  function load() {
    if (keys) return keys;
    keys = { anthropic: '', eleven: '' };
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const k of Object.keys(keys)) {
        const v = saved[k];
        if (!v) continue;
        if (v.enc) { try { keys[k] = safeStorage.decryptString(Buffer.from(v.enc, 'base64')); } catch {} }
        else if (v.raw) keys[k] = v.raw;
      }
    } catch {}
    return keys;
  }
  function store() {
    const enc = safeStorage.isEncryptionAvailable();
    const out = {};
    for (const k of Object.keys(keys)) if (keys[k]) out[k] = enc ? { enc: safeStorage.encryptString(keys[k]).toString('base64') } : { raw: keys[k] };
    try { fs.writeFileSync(file(), JSON.stringify(out), { mode: 0o600 }); } catch (e) { console.error('[chat] keys not saved: ' + e.message); }
  }
  const status = () => { const k = load(); return { chat: !!k.anthropic, voice: !!k.eleven }; };
  const why = (e) => (e && e.status === 401 ? 'key' : e && e.status === 400 && /credit/i.test(e.message || '') ? 'credit' : e && (e.status === 429 || e.status === 529) ? 'busy' : 'failed');

  ipcMain.handle('chat-status', () => status());

  // Keys are checked before they are kept, so a typo is caught at the prompt and not mid-sentence.
  ipcMain.handle('chat-set-keys', async (_e, k) => {
    load();
    const a = String((k && k.anthropic) || '').trim(), x = String((k && k.eleven) || '').trim();
    if (a) {
      try { await brain.makeClient(a).models.list({ limit: 1 }); }
      catch (e) { return { ok: false, field: 'anthropic', error: e.status === 401 || e.status === 403 ? 'That Claude key was not accepted.' : 'Could not reach Claude to check the key. Are you online?' }; }
    }
    if (x) {
      try {
        const r = await fetch(brain.XI + '/user', { headers: { 'xi-api-key': x } });
        // a restricted key may not be allowed to read the account and still speak; only a key that is not a key is refused
        if (r.status === 401 && /invalid_api_key/.test(await r.text())) return { ok: false, field: 'eleven', error: 'That ElevenLabs key was not accepted.' };
      } catch { return { ok: false, field: 'eleven', error: 'Could not reach ElevenLabs to check the key.' }; }
    }
    if (a) { keys.anthropic = a; client = null; }
    if (k && 'eleven' in k) { keys.eleven = x; voiceState.voice = 0; }
    store();
    return { ok: true, ...status() };
  });

  ipcMain.on('chat-send', async (_e, id, body) => {
    const k = load();
    const messages = brain.cleanMessages(body && body.messages);
    if (!k.anthropic || !messages) { send({ id, t: 'err', msg: k.anthropic ? 'failed' : 'key' }); send({ id, t: 'done' }); return; }
    client = client || brain.makeClient(k.anthropic);
    const conv = { stream: null, gone: false };
    live.set(id, conv);
    let n = 0;
    try {
      await brain.converse({
        client, messages, ctx: body.ctx,
        onStream: (st) => { conv.stream = st; if (conv.gone) st.abort(); },
        onPiece: (piece, text) => {
          if (conv.gone) return;
          const i = n++, voiced = !!k.eleven;
          send({ id, t: 'say', n: i, text, voiced });
          if (!voiced) return;
          // the whole piece is fetched here and handed over as bytes: a sentence is small
          brain.tts(k.eleven, piece, voiceState)
            .then(async (r) => { if (!r.ok) throw new Error('elevenlabs ' + r.status + ': ' + (await r.text()).slice(0, 160)); return r.arrayBuffer(); })
            .then((buf) => { if (!conv.gone) send({ id, t: 'audio', n: i, buf }); })
            .catch((e) => { console.error('[chat] voice: ' + e.message); if (!conv.gone) send({ id, t: 'audio', n: i, buf: null }); });
        },
      });
    } catch (e) {
      if (!conv.gone) { console.error('[chat] ' + (e.status || '') + ' ' + e.message); send({ id, t: 'err', msg: why(e) }); }
    } finally {
      live.delete(id);
      send({ id, t: 'done' });
    }
  });
  ipcMain.on('chat-abort', (_e, id) => { const c = live.get(id); if (c) { c.gone = true; if (c.stream) c.stream.abort(); } });

  ipcMain.handle('chat-stt', async (_e, buf, mime) => {
    const k = load();
    if (!k.eleven || !buf || buf.byteLength < 800) return { text: '' };
    try { return { text: await brain.transcribe(k.eleven, buf, mime) }; }
    catch (e) { console.error('[chat] ' + e.message); return { text: '' }; }
  });
}

module.exports = { init };
