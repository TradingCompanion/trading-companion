// voice.js — procedural "anime girl" vocalisations with Web Audio.
// No samples, no words: a pulse-train glottal source (f0 400–700 Hz, vibrato),
// three parallel formant filters that glide between vowel targets, a breath
// noise layer for h-onsets/sighs, and per-syllable envelopes. Every sound is a
// tiny script of segments; see PHRASES at the bottom.

// female formant targets (Hz), scaled up a bit for a smaller/cuter vocal tract
const VOWELS = {
  a: [850, 1220, 2810], i: [310, 2790, 3310], u: [370, 950, 2670], e: [610, 2330, 2990], o: [590, 920, 2710],
  n: [260, 1100, 2300],   // closed-mouth hum
  h: [700, 1500, 2600],   // breathy neutral
};
const F_GAIN = [1.0, 0.55, 0.28];
const F_Q = [9, 12, 12];

export function createVoice(ctx, opts = {}) {
  const master = ctx.createGain();
  master.gain.value = opts.volume ?? 0.6;
  master.connect(ctx.destination);
  const state = { pitch: opts.pitch ?? 1.0, volume: opts.volume ?? 0.6, timbre: opts.timbre ?? 1.08 };

  function periodicWave() {
    // pulse-like spectrum: harmonics roll off ~1/n^1.1, slight even/odd shaping
    const N = 40, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) im[n] = (1 / Math.pow(n, 1.1)) * (n % 2 ? 1 : 0.85);
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }
  const wave = periodicWave();

  let noiseBuf = null;
  function noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    const len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return (noiseBuf = b);
  }

  /**
   * play a phrase: array of segments
   * { d: seconds, v: vowel key or [from,to], f: f0 Hz or [from,to] (relative to 500), a: amplitude 0..1,
   *   br: breathiness 0..1, atk/rel: envelope seconds, vib: vibrato depth (semitones), gap: silence after }
   */
  function play(phrase, o = {}) {
    const t0 = ctx.currentTime + 0.02;
    const pitch = (o.pitch ?? state.pitch);
    const timbre = (o.timbre ?? state.timbre);
    const out = ctx.createGain();
    out.gain.value = o.volume ?? 1; // master gain already carries state.volume
    out.connect(master);

    // --- voiced path: osc -> [3 formant filters] -> env -> out
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    const vib = ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 5.6;
    const vibGain = ctx.createGain(); vibGain.gain.value = 0;
    vib.connect(vibGain).connect(osc.frequency);
    const voiced = ctx.createGain(); voiced.gain.value = 0;
    const filters = VOWELS.a.map((f, i) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * timbre; bp.Q.value = F_Q[i];
      const g = ctx.createGain(); g.gain.value = F_GAIN[i];
      osc.connect(bp).connect(g).connect(voiced);
      return bp;
    });
    // soften the top end a little
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500; lp.Q.value = 0.5;
    voiced.connect(lp).connect(out);

    // --- breath path: noise -> bandpass -> env -> out
    const noise = ctx.createBufferSource(); noise.buffer = noiseBuffer(); noise.loop = true;
    const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.frequency.value = 1800; nbp.Q.value = 0.7;
    const breath = ctx.createGain(); breath.gain.value = 0;
    noise.connect(nbp).connect(breath).connect(out);

    let t = t0;
    let total = 0;
    for (const seg of phrase) {
      const d = seg.d;
      const [v0, v1] = Array.isArray(seg.v) ? seg.v : [seg.v, seg.v];
      const [p0, p1] = Array.isArray(seg.f) ? seg.f : [seg.f, seg.f];
      const amp = seg.a ?? 0.8, br = seg.br ?? 0.08;
      const atk = Math.min(seg.atk ?? 0.04, d * 0.4), rel = Math.min(seg.rel ?? 0.06, d * 0.5);
      const f0a = 500 * pitch * (p0 ?? 1), f0b = 500 * pitch * (p1 ?? p0 ?? 1);
      osc.frequency.setValueAtTime(f0a, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(60, f0b), t + d);
      vibGain.gain.setValueAtTime(f0a * ((seg.vib ?? 0.35) / 12) * 0.6, t);
      const fa = VOWELS[v0] || VOWELS.a, fb = VOWELS[v1] || VOWELS.a;
      filters.forEach((bp, i) => {
        bp.frequency.setValueAtTime(fa[i] * timbre, t);
        bp.frequency.linearRampToValueAtTime(fb[i] * timbre, t + d);
      });
      // envelopes
      voiced.gain.setValueAtTime(0.0001, t);
      voiced.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * (1 - br * 0.6)), t + atk);
      if (seg.shape === 'decay') voiced.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * 0.35), t + d - rel);
      else voiced.gain.setValueAtTime(Math.max(0.0002, amp * (1 - br * 0.6)), t + d - rel);
      voiced.gain.exponentialRampToValueAtTime(0.0001, t + d);
      breath.gain.setValueAtTime(0.0001, t);
      breath.gain.exponentialRampToValueAtTime(Math.max(0.0002, br * 0.5), t + Math.min(0.03, d * 0.3));
      breath.gain.exponentialRampToValueAtTime(0.0001, t + d);
      t += d + (seg.gap ?? 0);
      total += d + (seg.gap ?? 0);
    }
    osc.start(t0); vib.start(t0); noise.start(t0);
    osc.stop(t + 0.05); vib.stop(t + 0.05); noise.stop(t + 0.05);
    osc.onended = () => { try { out.disconnect(); } catch {} };
    return total;
  }

  function set(o) { Object.assign(state, o); master.gain.value = state.volume; }
  return { play, set, state, master };
}

// helpers to write phrases compactly
const S = (d, v, f, a = 0.8, extra = {}) => ({ d, v, f, a, ...extra });

// ------------------------------------------------------------- the soundboard
export const PHRASES = {
  // ---- happy / excited
  yay:      { label: 'Yay~!',        mood: 'happy',    seq: [S(0.09, 'i', [0.95, 1.25], 0.7, { atk: 0.02 }), S(0.42, ['a', 'a'], [1.25, 1.45], 0.95, { vib: 0.6, shape: 'decay' })] },
  wai:      { label: 'Wa~i!',        mood: 'happy',    seq: [S(0.12, ['u', 'a'], [0.9, 1.15], 0.85), S(0.38, ['a', 'i'], [1.15, 1.5], 0.9, { vib: 0.5, shape: 'decay' })] },
  giggle:   { label: 'Ehehe',        mood: 'happy',    seq: [S(0.11, 'e', [1.2, 1.1], 0.7, { br: 0.3, gap: 0.05 }), S(0.1, 'e', [1.15, 1.05], 0.65, { br: 0.3, gap: 0.05 }), S(0.1, 'e', [1.1, 1.0], 0.6, { br: 0.3, gap: 0.05 }), S(0.14, 'e', [1.05, 0.9], 0.5, { br: 0.35, shape: 'decay' })] },
  fufu:     { label: 'Fufu~',        mood: 'happy',    seq: [S(0.13, ['u', 'u'], [1.15, 1.1], 0.55, { br: 0.4, gap: 0.06 }), S(0.13, ['u', 'u'], [1.1, 1.0], 0.55, { br: 0.4, gap: 0.06 }), S(0.2, ['u', 'n'], [1.05, 0.85], 0.45, { br: 0.3, shape: 'decay' })] },
  hum:      { label: 'Nn~♪',         mood: 'happy',    seq: [S(0.25, 'n', [1.0, 1.05], 0.6, { vib: 0.5 }), S(0.2, 'n', [1.25, 1.25], 0.6), S(0.35, 'n', [1.12, 1.1], 0.6, { vib: 0.6, shape: 'decay' })] },
  ooh:      { label: 'Ooh~!',        mood: 'happy',    seq: [S(0.5, ['o', 'u'], [0.95, 1.35], 0.85, { atk: 0.08, vib: 0.5, shape: 'decay' })] },
  un:       { label: 'Un!',          mood: 'happy',    seq: [S(0.18, ['u', 'n'], [1.05, 1.3], 0.85, { atk: 0.02, rel: 0.05 })] },
  hehe:     { label: 'Hehe~',        mood: 'happy',    seq: [S(0.12, 'e', [1.3, 1.2], 0.6, { br: 0.45, gap: 0.04 }), S(0.22, 'e', [1.25, 1.05], 0.6, { br: 0.4, vib: 0.5, shape: 'decay' })] },

  // ---- comforting / soft
  soothe:   { label: 'Nnn~ (soft)',  mood: 'comfort',  seq: [S(0.55, 'n', [0.95, 1.02], 0.5, { atk: 0.12, vib: 0.4, shape: 'decay' }), S(0.4, ['n', 'u'], [0.98, 0.85], 0.45, { atk: 0.06, shape: 'decay' })] },
  ehh_soft: { label: 'Eh~… (gentle)',mood: 'comfort',  seq: [S(0.5, ['e', 'e'], [1.1, 0.9], 0.6, { atk: 0.08, vib: 0.4, shape: 'decay' })] },
  sigh:     { label: 'Haa…',         mood: 'comfort',  seq: [S(0.65, ['h', 'a'], [1.0, 0.8], 0.45, { br: 0.8, atk: 0.1, shape: 'decay' })] },
  muu:      { label: 'Muu~',         mood: 'comfort',  seq: [S(0.45, ['n', 'u'], [1.05, 0.92], 0.65, { atk: 0.05, vib: 0.5, shape: 'decay' })] },
  uu:       { label: 'Uu~ (sad)',    mood: 'comfort',  seq: [S(0.3, 'u', [1.1, 1.0], 0.6, { atk: 0.04, gap: 0.05 }), S(0.4, ['u', 'u'], [1.0, 0.82], 0.55, { vib: 0.7, shape: 'decay' })] },
  nnn_q:    { label: 'Nn? (worried)',mood: 'comfort',  seq: [S(0.32, 'n', [0.95, 1.3], 0.6, { atk: 0.05 })] },

  // ---- surprise / reactions to being handled
  eh:       { label: 'Eh?!',         mood: 'surprise', seq: [S(0.22, 'e', [1.1, 1.55], 0.9, { atk: 0.015 })] },
  hyaa:     { label: 'Hyaa!',        mood: 'surprise', seq: [S(0.06, ['h', 'i'], [1.3, 1.6], 0.7, { br: 0.5 }), S(0.3, ['a', 'a'], [1.6, 1.25], 0.95, { shape: 'decay' })] },
  kyaa:     { label: 'Kyaa~!',       mood: 'surprise', seq: [S(0.05, 'i', [1.5, 1.7], 0.6, { atk: 0.01 }), S(0.45, ['a', 'a'], [1.7, 1.2], 0.95, { vib: 0.8, shape: 'decay' })] },
  uwaa:     { label: 'Uwaa!',        mood: 'surprise', seq: [S(0.1, 'u', [1.0, 1.2], 0.7), S(0.4, ['a', 'a'], [1.35, 1.1], 0.9, { vib: 0.6, shape: 'decay' })] },
  au:       { label: 'Au! (bump)',   mood: 'surprise', seq: [S(0.16, ['a', 'u'], [1.3, 1.0], 0.9, { atk: 0.01, rel: 0.06 })] },
  hnn:      { label: 'Hnn~ (dizzy)', mood: 'surprise', seq: [S(0.6, ['n', 'u'], [1.15, 0.85], 0.6, { vib: 1.6, atk: 0.06, shape: 'decay' })] },
  hm:       { label: 'Hm?',          mood: 'surprise', seq: [S(0.22, ['n', 'n'], [0.95, 1.25], 0.6, { atk: 0.03 })] },

  // ---- greeting / attention
  hai:      { label: 'Ha~i♪',        mood: 'greet',    seq: [S(0.12, ['h', 'a'], [1.15, 1.2], 0.75, { br: 0.35 }), S(0.3, ['a', 'i'], [1.2, 1.45], 0.8, { vib: 0.5, shape: 'decay' })] },
  ne:       { label: 'Ne~?',         mood: 'greet',    seq: [S(0.35, ['n', 'e'], [1.0, 1.35], 0.7, { atk: 0.05, vib: 0.4 })] },
  oh:       { label: 'Oh!',          mood: 'greet',    seq: [S(0.2, ['o', 'o'], [1.1, 1.3], 0.85, { atk: 0.02 })] },
};

export const MOODS = ['happy', 'comfort', 'surprise', 'greet'];
