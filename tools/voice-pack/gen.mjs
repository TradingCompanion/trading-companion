// Generate Yui's voice pack with ElevenLabs.
//   node tools/voice-pack/gen.mjs voices                      list the account's voices
//   node tools/voice-pack/gen.mjs samples <voiceId>[,id2..]   three sample lines per voice → web/assets/voice-samples/
//   node tools/voice-pack/gen.mjs pack <voiceId>              the whole script → sounds/yui-*.mp3 + src/voice-pack.js
// Key: .elevenlabs.key at the repo root (gitignored) or $ELEVENLABS_API_KEY. Audio is cached by
// (voice, model, settings, text) so re-runs only pay for changed lines.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { events, clips } from './lines.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const API = 'https://api.elevenlabs.io/v1';
const MODEL = process.env.XI_MODEL || 'eleven_v3';
// v3 takes stability as Creative/Natural/Robust (0 / 0.5 / 1) and reads audio tags in the text
const SETTINGS = MODEL === 'eleven_v3' ? { stability: 0.5, similarity_boost: 0.85 } : { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true };
// the mood each group is read in (v3 audio tags); a line can carry its own tag instead
const TAGS = { greet: '[happy]', connect: '[happy]', buy: '[curious]', bigBuy: '[gasps]', sellFlat: '[calm]', profit: '[happy]', bigProfit: '[excited]', loss: '[sad]', bigLoss: '[sad]', guard: '[suspicious]', milestone: '[excited]', cheerUp: '[warm]', grab: '[surprised]', throw: '[screaming]', land: '[groans]', dizzy: '[dizzy]', jump: '[playful]', stretch: '[sleepy]', hover: '[playful]', click: '[giggles]', sleep: '[whispers]', wake: '[surprised]', scorecard: '[proud]' };
const CLIP_TAGS = [[/Cry|FeelDown|Damage|Stumble/, '[sad]'], [/Laugh|Dance|Cute|Shy|Peace|Cheek|Idol/, '[giggles]'], [/Yay|Cheer|Jump|Shout|Cartwheel|Backflip|Handstand|HighFive|Motivated|ThumbsUp/, '[excited]'], [/Angry|Tsundere|Shush|Refusal/, '[annoyed]'], [/Surpris/, '[surprised]'], [/Sleep|Sleepy|Stretch/, '[sleepy]'], [/Sneeze/, '[sneezes]']];
const tagged = (tag, text) => (/^\[/.test(text) || !tag ? text : tag + ' ' + text);
function key() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  for (const f of ['.elevenlabs.key', 'elevenlabs.local.key']) { try { const k = fs.readFileSync(path.join(ROOT, f), 'utf8').trim(); if (k) return k; } catch {} }
  console.error('no ElevenLabs key: echo "KEY" > ' + path.join(ROOT, '.elevenlabs.key')); process.exit(1);
}
const KEY = key();
const H = { 'xi-api-key': KEY };
const CACHE = path.join(ROOT, 'tools/voice-pack/cache'); fs.mkdirSync(CACHE, { recursive: true });
async function tts(voiceId, text) {
  const id = crypto.createHash('sha1').update(JSON.stringify({ voiceId, MODEL, SETTINGS, text })).digest('hex');
  const c = path.join(CACHE, id + '.mp3');
  if (fs.existsSync(c)) return fs.readFileSync(c);
  const r = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }) });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(c, buf); return buf;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'voices') {
  const r = await fetch(`${API}/voices`, { headers: H }); const j = await r.json();
  for (const v of j.voices || []) console.log(`${v.voice_id}  ${v.name.padEnd(24)} ${v.category.padEnd(12)} ${Object.entries(v.labels || {}).map(([k, x]) => k + '=' + x).join(' ')}`);
  const s = await fetch(`${API}/user/subscription`, { headers: H }).then((x) => x.json()).catch(() => null);
  if (s) console.log(`\ncharacters: ${s.character_count} / ${s.character_limit} (${s.tier})`);
} else if (cmd === 'samples') {
  const ids = (arg || '').split(',').filter(Boolean); if (!ids.length) { console.error('samples <voiceId,...>'); process.exit(1); }
  const lines = ["Hi! I'm Yui, your trading companion~ Ehehe, hello!", "Nice trade! Green looks good on you~", "Ouch… it's okay. Losses happen. Breathe~ I'm here."];
  const out = path.join(ROOT, 'web/assets/voice-samples'); fs.mkdirSync(out, { recursive: true });
  const names = {}; try { const j = await fetch(`${API}/voices`, { headers: H }).then((r) => r.json()); for (const v of j.voices || []) names[v.voice_id] = v.name; } catch {}
  let html = '<!doctype html><meta charset=utf-8><title>Yui voice samples</title><body style="font:15px system-ui;background:#111;color:#eee;padding:24px">';
  for (const id of ids) {
    html += `<h3>${names[id] || id} <small style="color:#888">${id}</small></h3>`;
    for (let i = 0; i < lines.length; i++) { const f = `${id}-${i + 1}.mp3`; fs.writeFileSync(path.join(out, f), await tts(id, lines[i])); html += `<p><audio controls src="assets/voice-samples/${f}"></audio> ${lines[i]}</p>`; console.log('sample', id, i + 1); }
  }
  fs.writeFileSync(path.join(ROOT, 'web/voice-samples.html'), html);
  console.log('→ /voice-samples.html');
} else if (cmd === 'pack') {
  const voiceId = arg; if (!voiceId) { console.error('pack <voiceId>'); process.exit(1); }
  const dir = path.join(ROOT, 'sounds');
  const pack = { voiceId, model: MODEL, events: {}, clips: {} };
  let n = 0, chars = 0;
  const gen = async (name, text) => { const f = `yui-${name}.mp3`; fs.writeFileSync(path.join(dir, f), await tts(voiceId, text)); n++; chars += text.length; return 'file:' + f; };
  // a few at a time: 246 lines one by one would take a while
  const jobs = [];
  for (const [ev, list] of Object.entries(events)) { pack.events[ev] = new Array(list.length); list.forEach((t, i) => jobs.push(async () => { pack.events[ev][i] = await gen(`${ev}-${i + 1}`, tagged(TAGS[ev], t)); })); }
  for (const [clip, list] of Object.entries(clips)) { const base = slug(clip.split('/').pop()); const tag = (CLIP_TAGS.find(([re]) => re.test(clip)) || [])[1]; pack.clips[clip] = new Array(list.length); list.forEach((t, i) => jobs.push(async () => { pack.clips[clip][i] = await gen(`${base}-${i + 1}`, tagged(tag, t)); })); }
  let next = 0; const worker = async () => { while (next < jobs.length) { const j = jobs[next++]; try { await j(); } catch (e) { console.error('  !', e.message); await j(); } if (next % 20 === 0) console.log(`  ${next}/${jobs.length}`); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  fs.writeFileSync(path.join(ROOT, 'src/voice-pack.js'), '// Generated by tools/voice-pack/gen.mjs — do not edit. Lines live in tools/voice-pack/lines.mjs.\nexport const VOICE_PACK = ' + JSON.stringify(pack, null, 1) + ';\n');
  console.log(`pack: ${n} lines, ${chars} characters → sounds/yui-*.mp3, src/voice-pack.js`);
} else console.error('usage: gen.mjs voices | samples <ids> | pack <voiceId>');
