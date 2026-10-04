// Yui talks back (the website only).
//
// scripts/serve-web.js hands every /api/yui/* request here. A visitor's line goes to Claude, the
// answer streams back sentence by sentence, and each piece is read by her ElevenLabs voice while
// the text is still arriving, so she starts speaking about as soon as she has a first sentence.
//
//   POST /api/yui/chat    { messages: [{role, content}], ctx: {pnl, trades} }  ->  event stream
//                           {t:'say', text, id}   one spoken piece; id = its audio, null = text only
//                           {t:'done'} | {t:'err', msg}
//   GET  /api/yui/audio/<id>   the mp3 of one piece, streamed as ElevenLabs produces it (one read)
//   POST /api/yui/stt     raw recorded audio -> { text }   (browsers with no speech recognition)
//   GET  /api/yui/status  { chat, voice }
//
// Both keys stay on this box: .anthropic.key / .elevenlabs.key at the repo root (gitignored) or
// $ANTHROPIC_API_KEY / $ELEVENLABS_API_KEY. The page never sees either, and the voice only ever
// reads what Claude wrote, so nobody can use it as a free text-to-speech endpoint.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const brain = require('../src/yui-brain.js');

const ROOT = path.resolve(__dirname, '..');
// The key file wins over the environment: pm2 keeps whatever the shell that first started the app
// happened to export, and a stale variable there must not shadow the real key.
function keyOf(env, files) {
  for (const f of files) { try { const k = fs.readFileSync(path.join(ROOT, f), 'utf8').trim(); if (k) return k; } catch {} }
  return (process.env[env] || '').trim();
}
const ANTHROPIC_KEY = keyOf('ANTHROPIC_API_KEY', ['.anthropic.key']);
const XI_KEY = keyOf('ELEVENLABS_API_KEY', ['.elevenlabs.key', 'elevenlabs.local.key']);

const MODEL = process.env.YUI_MODEL || brain.MODEL;
const TTS_OPTS = { voice: process.env.YUI_VOICE || 'ocZQ262SsZb9RIxcQBOj', model: process.env.YUI_XI_MODEL || brain.XI_MODEL };

// The site is public and both keys are paid, so each visitor gets a generous but finite allowance
// and her voice has a daily character budget (the ElevenLabs plan is counted in characters per
// month). Past the voice budget she keeps answering, in the bubble only.
const PER_10MIN = Number(process.env.YUI_CHAT_PER_10MIN || 40);
const PER_DAY = Number(process.env.YUI_CHAT_PER_DAY || 400);
const VOICE_CHARS_DAY = Number(process.env.YUI_VOICE_CHARS_DAY || 12000);
const MAX_SPOKEN = 700, MAX_STT_BYTES = 3 * 1048576;

const client = ANTHROPIC_KEY ? brain.makeClient(ANTHROPIC_KEY, process.env.YUI_ANTHROPIC_URL) : null;
const { cleanMessages, bubbleText } = brain;

// ---- allowances ----------------------------------------------------------------------------
const visitors = new Map();   // ip -> { recent: [ms], day, used }
const today = () => new Date().toISOString().slice(0, 10);
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  const xff = req.headers['x-forwarded-for'];
  // Caddy appends the real peer; only a loopback hop (Caddy itself) is believed
  if (xff && /^(::1|127\.|::ffff:127\.)/.test(ra)) return String(xff).split(',').pop().trim();
  return ra;
}
function allow(ip) {
  const now = Date.now(), d = today();
  let v = visitors.get(ip);
  if (!v) visitors.set(ip, v = { recent: [], day: d, used: 0 });
  if (v.day !== d) { v.day = d; v.used = 0; }
  v.recent = v.recent.filter((t) => now - t < 600000);
  if (v.recent.length >= PER_10MIN || v.used >= PER_DAY) return null;
  v.recent.push(now); v.used++;
  return v;
}
setInterval(() => { const now = Date.now(), d = today(); for (const [ip, v] of visitors) if (v.day !== d || (!v.recent.some((t) => now - t < 600000) && v.used < PER_DAY)) visitors.delete(ip); }, 600000).unref();

const voiceDay = { day: today(), chars: 0 };
function voiceBudget(n) {
  const d = today();
  if (voiceDay.day !== d) { voiceDay.day = d; voiceDay.chars = 0; }
  if (voiceDay.chars + n > VOICE_CHARS_DAY) return false;
  voiceDay.chars += n;
  return true;
}

// ---- her voice -----------------------------------------------------------------------------
// A piece's audio is requested from ElevenLabs the moment its text is complete and held here until
// the page comes for it; the page's <audio> then plays the stream as it is produced.
const audio = new Map();      // id -> { res: Promise<Response>, at }
function speak(text) {
  if (!XI_KEY || !voiceBudget(text.length)) return null;
  const id = crypto.randomBytes(12).toString('hex');
  const res = brain.tts(XI_KEY, text, null, TTS_OPTS);
  res.catch(() => {});
  audio.set(id, { res, at: Date.now() });
  return id;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of audio) if (now - a.at > 90000) { audio.delete(id); a.res.then((r) => r.body && r.body.cancel()).catch(() => {}); }
}, 30000).unref();

async function serveAudio(id, res) {
  const a = audio.get(id);
  if (!a) { res.writeHead(404).end(); return; }
  audio.delete(id);
  try {
    const r = await a.res;
    if (!r.ok || !r.body) { console.error('[yui-chat] elevenlabs ' + r.status + ': ' + (await r.text()).slice(0, 200)); res.writeHead(502).end(); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
  } catch (e) { console.error('[yui-chat] voice: ' + e.message); if (!res.headersSent) res.writeHead(502); res.end(); }
}

// ---- the conversation ----------------------------------------------------------------------
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));

async function chat(req, res) {
  if (!client) return json(res, 503, { error: 'chat is not set up' });
  let body;
  try { body = JSON.parse((await readBody(req, 65536)).toString('utf8')); } catch { return json(res, 400, { error: 'bad request' }); }
  const messages = cleanMessages(body && body.messages);
  if (!messages) return json(res, 400, { error: 'bad request' });
  const v = allow(clientIp(req));
  if (!v) return json(res, 429, { error: 'slow down' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  const send = (o) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
  let gone = false, stream = null;
  res.on('close', () => { gone = true; if (stream) stream.abort(); });

  let spoken = 0;
  try {
    await brain.converse({
      client, model: MODEL, messages, ctx: body.ctx,
      onStream: (st) => { stream = st; if (gone) st.abort(); },
      onPiece: (piece, text) => {
        if (gone) return;
        const id = MAX_SPOKEN - spoken >= piece.length ? speak(piece) : null;
        if (id) spoken += piece.length;
        send({ t: 'say', text, id });
      },
    });
    send({ t: 'done' });
  } catch (e) {
    if (!gone) { console.error('[yui-chat] ' + (e.status || '') + ' ' + e.message); send({ t: 'err', msg: e.status === 429 || e.status === 529 ? 'busy' : 'failed' }); }
  } finally {
    res.end();
  }
}

// Speech to text for browsers with no recognition of their own: the page records, this transcribes.
async function stt(req, res) {
  if (!XI_KEY) return json(res, 503, { error: 'not set up' });
  if (!allow(clientIp(req))) return json(res, 429, { error: 'slow down' });
  let buf;
  try { buf = await readBody(req, MAX_STT_BYTES); } catch { return json(res, 413, { error: 'too long' }); }
  if (buf.length < 800) return json(res, 200, { text: '' });
  try {
    json(res, 200, { text: await brain.transcribe(XI_KEY, buf, req.headers['content-type'], process.env.YUI_STT_MODEL) });
  } catch (e) { console.error('[yui-chat] stt: ' + e.message); json(res, 502, { error: 'failed' }); }
}

function handle(req, res) {
  const url = req.url.split('?')[0];
  if (url === '/api/yui/status' && req.method === 'GET') return json(res, 200, { chat: !!client, voice: !!XI_KEY });
  if (url === '/api/yui/chat' && req.method === 'POST') return void chat(req, res).catch((e) => { console.error('[yui-chat] ' + e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
  if (url === '/api/yui/stt' && req.method === 'POST') return void stt(req, res);
  const m = /^\/api\/yui\/audio\/([0-9a-f]{24})$/.exec(url);
  if (m && req.method === 'GET') return void serveAudio(m[1], res);
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
}

module.exports = { handle, cleanMessages, bubbleText };
