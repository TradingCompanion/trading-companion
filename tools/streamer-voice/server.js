// streamer-voice — type a line, Yui says it out loud, on stream.
//
// This is the STREAMER-ONLY tool. It is deliberately not part of the app: it lives outside
// every packaging whitelist, holds an ElevenLabs API key, and costs credits per line. The
// public build of Yui never contains any of it.
//
//   node tools/streamer-voice/server.js     ->  http://127.0.0.1:4321
//
// The key is read from .elevenlabs.key at the repo root (git-ignored, never packaged) or
// from $ELEVENLABS_API_KEY. It stays in this process; the browser page never sees it.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');
const CACHE = path.join(__dirname, 'cache');
const PORT = Number(process.env.VOICE_PORT || 4321);
const API = 'https://api.elevenlabs.io/v1';

fs.mkdirSync(CACHE, { recursive: true });

// The key lives OUTSIDE the repo: in ELEVENLABS_API_KEY, or in .elevenlabs.key / elevenlabs.local.key
// at the project root (both gitignored). Never paste a key into this file; it is committed.
const HARDCODED_KEY = '';

function loadKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  for (const f of ['.elevenlabs.key', 'elevenlabs.local.key']) {
    try { const k = fs.readFileSync(path.join(ROOT, f), 'utf8').trim(); if (k) return k; } catch {}
  }
  return HARDCODED_KEY;
}
const KEY = loadKey();
if (!KEY) {
  console.error('\n  No ElevenLabs API key found.\n');
  console.error('  Create one at elevenlabs.io -> profile -> API Keys, then:\n');
  console.error(`      echo "YOUR_KEY" > ${path.join(ROOT, '.elevenlabs.key')}\n`);
  process.exit(1);
}

// Replays cost nothing: the same text in the same voice with the same knobs is the same audio.
const cacheKey = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

function json(res, code, body) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
}

async function speak(req, res) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e6) return req.destroy(); }
  let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }

  const text = String(body.text || '').trim();
  const voiceId = String(body.voiceId || '').trim();
  if (!text) return json(res, 400, { error: 'empty text' });
  if (!voiceId) return json(res, 400, { error: 'no voice selected' });

  const model = body.model || 'eleven_flash_v2_5';
  const settings = {
    stability: Number(body.stability ?? 0.35),
    similarity_boost: Number(body.similarity ?? 0.8),
    style: Number(body.style ?? 0.3),
    use_speaker_boost: true,
  };

  const hit = path.join(CACHE, cacheKey({ text, voiceId, model, settings }) + '.mp3');
  if (fs.existsSync(hit)) {
    const buf = fs.readFileSync(hit);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'x-cached': '1' });
    return res.end(buf);
  }

  const t0 = Date.now();
  let r;
  try {
    r = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
    });
  } catch (e) { return json(res, 502, { error: 'network: ' + e.message }); }

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('[tts]', r.status, detail.slice(0, 300));
    return json(res, r.status, { error: `elevenlabs ${r.status}`, detail: detail.slice(0, 300) });
  }

  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(hit, buf);
  console.log(`[tts] ${Date.now() - t0}ms  ${text.length} chars  "${text.slice(0, 60)}"`);
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'x-cached': '0' });
  res.end(buf);
}

async function voices(_req, res) {
  try {
    const r = await fetch(`${API}/voices`, { headers: { 'xi-api-key': KEY } });
    if (!r.ok) return json(res, r.status, { error: `elevenlabs ${r.status}` });
    const d = await r.json();
    json(res, 200, (d.voices || []).map((v) => ({
      id: v.voice_id, name: v.name, category: v.category, preview: v.preview_url,
    })));
  } catch (e) { json(res, 502, { error: e.message }); }
}

async function usage(_req, res) {
  try {
    const r = await fetch(`${API}/user/subscription`, { headers: { 'xi-api-key': KEY } });
    if (!r.ok) return json(res, r.status, { error: `elevenlabs ${r.status}` });
    const d = await r.json();
    json(res, 200, { used: d.character_count, limit: d.character_limit, tier: d.tier });
  } catch (e) { json(res, 502, { error: e.message }); }
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/speak') return speak(req, res);
  if (url === '/voices') return voices(req, res);
  if (url === '/usage') return usage(req, res);
  if (url === '/' || url === '/index.html') {
    const b = fs.readFileSync(path.join(__dirname, 'ui.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length });
    return res.end(b);
  }
  res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Yui stream voice  ->  http://127.0.0.1:${PORT}\n`);
});
