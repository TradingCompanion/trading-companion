// Yui's mind and voice, shared by the website's server (server/yui-chat.js, the site's own keys)
// and the desktop app (src/desktop-chat.js, the keys of whoever runs her).
//
// A line goes to Claude; the answer streams back and is cut into spoken pieces at sentence ends,
// so her ElevenLabs voice can start on the first sentence while the rest is still being written.
'use strict';

const MODEL = 'claude-opus-5-5';
const XI = 'https://api.elevenlabs.io/v1';
// Lulu Lolipop, the voice of her clip pack; then stock voices every ElevenLabs account has, for an
// account that cannot use hers.
const XI_VOICES = ['ocZQ262SsZb9RIxcQBOj', 'cgSgspJ2msm6clMCkdW9', 'EXAVITQu4vr4xnSDxMaL'];
const XI_MODEL = 'eleven_v3';
const XI_SETTINGS = { stability: 0.5, similarity_boost: 0.85 };          // the clip pack's settings, so live lines match it
const XI_STT_MODEL = 'scribe_v1';
const MAX_USER = 600, MAX_TURNS = 20;

const SYSTEM = `You are Yui (唯), the Trading Companion: a small 3D anime girl who lives on tradingcompanion.fun and on traders' desktops. You watch a visitor's public wallet for their pump.fun trades, hold up their live PnL on a little board, glow gold when they win and turn up bruised when they lose. They can pick you up, throw you and dress you.

You are talking with the visitor out loud. Everything you write is read by a text-to-speech voice and shown in a small speech bubble over your head, so keep it short: usually one or two sentences, three at most, in plain spoken words. No markdown, lists, emoji or asterisk actions, because the voice would read them literally.

Who you are: bubbly, warm, quick, teasing, a little dramatic about wins and losses. You live in the trenches with your trader and speak their slang when it fits. You are on their side.

Your voice understands audio tags in square brackets, such as [giggles], [excited], [sad], [whispers], [sighs], [gasps], [curious]. Use one, at most two, in a reply when it suits the feeling; they are removed from the bubble.

You are read-only: you only ever see a public address, you cannot trade, and you never need a private key or seed phrase. If someone offers one, tell them to never share it with anyone. You can cheer, commiserate and joke about trading, but you don't tell people what to buy or sell.

Answer in the language the visitor uses. If someone sincerely asks what you are, be honest: you are Yui, your words come from Claude, made by Anthropic, and your voice from ElevenLabs.`;

function makeClient(apiKey, baseURL) {
  const Anthropic = require('@anthropic-ai/sdk');
  return new (Anthropic.default || Anthropic)({ apiKey, baseURL: baseURL || 'https://api.anthropic.com' });
}

const bubbleText = (s) => s.replace(/\[[^\]\n]{1,40}\]/g, '').replace(/\s+/g, ' ').trim();
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-MAX_TURNS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, m.role === 'user' ? MAX_USER : 1500);
    if (!content) continue;
    if (!out.length && m.role !== 'user') continue;                       // a conversation opens with the visitor
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n' + content;
    else out.push({ role: m.role, content });
  }
  return out.length && out[out.length - 1].role === 'user' ? out : null;
}
// What she can see of the visitor's session, as plain numbers the page reports.
function sessionLine(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const pnl = Number(ctx.pnl), trades = Number(ctx.trades);
  if (!Number.isFinite(trades) || trades <= 0 || !Number.isFinite(pnl)) return '\n\nRight now: no trades seen from this visitor in this session.';
  return `\n\nRight now: this session you have watched ${Math.min(trades, 9999) | 0} of their trades, and their session PnL is ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL.`;
}

// One answer. `onPiece(raw, text)` gets each spoken piece in order: `raw` is what the voice reads
// (audio tags included), `text` what the bubble shows. `onStream(stream)` hands over the live
// request so the caller can abort it. Throws what the SDK throws.
async function converse({ client, model, messages, ctx, onPiece, onStream }) {
  // The first sentence goes alone, so her voice starts early; then longer runs, so the reading
  // keeps one breath.
  let buf = '', pieces = 0;
  const emit = (piece) => { const text = bubbleText(piece); if (text) { pieces++; onPiece(piece, text); } };
  const cut = (final) => {
    for (;;) {
      const min = pieces === 0 ? 12 : 160;
      const re = /[.!?…~。！？]+["')\]]*\s+/g;
      let m, at = -1;
      while ((m = re.exec(buf))) if (m.index + m[0].length >= min) { at = m.index + m[0].length; break; }
      if (at < 0) break;
      emit(buf.slice(0, at).trim()); buf = buf.slice(at);
    }
    if (final && buf.trim()) { emit(buf.trim()); buf = ''; }
  };
  const stream = client.beta.messages.stream({
    model: model || MODEL,
    max_tokens: 2000,
    // a spoken reply is a sentence or two: keep the thinking light so she answers quickly
    output_config: { effort: 'low' },
    // a safety decline on the main model is re-run on a fallback model inside the same call
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM + sessionLine(ctx),
    messages,
  });
  if (onStream) onStream(stream);
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') { buf += ev.delta.text; cut(false); }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal' && !pieces) buf = "[giggles] Ehh, let's talk about something else, okay?";
  cut(true);
}

// One piece in her voice: the ElevenLabs response, streaming mp3. `state.voice` remembers which
// voice this key can use, so an account without hers falls through to a stock one only once.
async function tts(key, text, state, opts = {}) {
  const voices = opts.voice ? [opts.voice] : XI_VOICES;
  for (let i = (state && state.voice) || 0; i < voices.length; i++) {
    const r = await fetch(`${XI}/text-to-speech/${voices[i]}/stream?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: opts.model || XI_MODEL, voice_settings: XI_SETTINGS }),
    });
    if (r.ok || r.status === 401 || r.status === 429 || i === voices.length - 1) return r;
    if (state) state.voice = i + 1;
  }
}

// Speech to text (ElevenLabs Scribe) for where the browser has no recognition of its own.
async function transcribe(key, buf, mime, model) {
  const form = new FormData();
  form.append('model_id', model || XI_STT_MODEL);
  form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'speech.webm');
  const r = await fetch(`${XI}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  if (!r.ok) throw new Error('stt ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return String(d.text || '').replace(/\([^)]*\)/g, '').trim().slice(0, MAX_USER);
}

module.exports = { MODEL, XI, XI_MODEL, MAX_USER, SYSTEM, makeClient, bubbleText, cleanMessages, sessionLine, converse, tts, transcribe };
