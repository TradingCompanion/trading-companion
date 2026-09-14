// Desktop pet renderer: Three.js + @pixiv/three-vrm.
// Everything visual/behavioural lives here; the Electron main process only
// supplies the model bytes, cursor position and click-through toggling.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, MToonMaterial } from '@pixiv/three-vrm';
import { createVoice, PHRASES, MOODS } from './voice.js';

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// smooth pseudo-random drift in [-1, 1] (sum of incommensurate sines)
const noise = (t) => 0.5 * Math.sin(t * 1.0) + 0.3 * Math.sin(t * 2.31 + 1.7) + 0.2 * Math.sin(t * 0.47 + 4.1);
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// bell-shaped weight for a timed action: ease in over `e`, hold, ease out.
const envelope = (t, dur, e = 0.5) => Math.min(smoothstep(t / e), smoothstep((dur - t) / e));

class Spring {
  constructor(value = 0, stiffness = 200, damping = 20) {
    this.v = value; this.vel = 0; this.k = stiffness; this.d = damping;
  }
  update(target, dt) {
    const a = (target - this.v) * this.k - this.vel * this.d;
    this.vel += a * dt;
    this.v += this.vel * dt;
    return this.v;
  }
}

const bridge = window.pet || {
  // fallback so the renderer also runs in a plain browser for development
  onCursor() {}, onSettings() {}, onModel() {}, onCommand() {},
  setIgnore() {}, contextMenu() {}, editMenu() {}, openExternal(u) { window.open(u, '_blank'); }, setDisplay() {}, saveState() {}, modelReady() {}, modelFailed() {}, requestModel() {}, log: console.log,
  saveSettings() {}, pickModel() {}, defaultModel() {}, quit() {}, openSoundsFolder() {}, rescanSounds() {},
};

// ---------------------------------------------------------------- scene
// She is rendered into a small canvas that follows her around the screen, so
// each frame only repaints ~2x her height instead of the whole desktop.
const canvas = document.createElement('canvas');
canvas.style.willChange = 'transform';
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
// She is small on screen, so her outline and eyelashes land on very few pixels. Draw her larger
// than she is shown and let the downsample do the anti-aliasing — the frame budget freed by the
// idle cap pays for it several times over.
// Capped in total, not just per factor: on a 4K screen at her largest size the buffer would
// otherwise reach ~16 megapixels, which a weak integrated GPU would feel.
const SUPERSAMPLE = 1.4;
renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * SUPERSAMPLE, 2.5));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const FOV = 24;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.3, 60);
let camDist = 8;

// Three-point lighting, the way a figure would be lit for a photo: a warm key slightly above and
// to her left, a cool fill on the other side to keep the shadows from going dead, and a bright
// rim from behind to draw a bright edge along her hair and shoulders. The rim is what stops her
// dissolving into whatever is on the desktop behind her.
scene.add(new THREE.HemisphereLight(0xffeede, 0x9aa6c8, 0.62));
const key = new THREE.DirectionalLight(0xfff3e4, 1.28);
key.position.set(-1.7, 2.4, 3.0);
scene.add(key);
const fill = new THREE.DirectionalLight(0xd6e6ff, 0.52);
fill.position.set(2.6, 0.6, 1.9);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffe4ee, 1.15);
rim.position.set(1.0, 2.3, -3.2);
scene.add(rim);

const lookTarget = new THREE.Object3D();
scene.add(lookTarget);

// soft contact shadow on the floor
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.8 }),
);
shadow.rotation.x = -Math.PI / 2;
shadow.renderOrder = -1;
scene.add(shadow);

let W = window.innerWidth, H = window.innerHeight;
let sizePx = 320;          // desired on-screen height of the character
let ppu = 200;             // pixels per world unit (on the z=0 plane)
let CS = 640;              // canvas size in CSS px (square)
let canvasLeft = 0, canvasTop = 0;
let groundY = -1;          // world y of the desktop "floor" (bottom of work area)
let minX = -1, maxX = 1;   // world x limits (screen edges)

function layout() {
  W = window.innerWidth; H = window.innerHeight;
  const modelH = model ? model.height : 1.6;
  ppu = sizePx / modelH;
  CS = Math.ceil(sizePx * 2.2);
  renderer.setSize(CS, CS, false);
  canvas.style.width = canvas.style.height = `${CS}px`;
  fx.style.width = fx.style.height = `${CS}px`;
  camera.aspect = 1;
  camera.fov = FOV;
  camera.updateProjectionMatrix();
  // distance at which the canvas spans exactly CS/ppu world units on the z=0 plane
  camDist = (CS / ppu / 2) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  groundY = -H / 2 / ppu + 1 / ppu;
  minX = -W / 2 / ppu + 0.45;
  maxX = W / 2 / ppu - 0.45;
  pet.x = clamp(pet.x, minX, maxX);
  if (pet.onGround) pet.y = groundY;
  springResetPending = 2;
}
window.addEventListener('resize', layout);

// screen <-> world on the z=0 plane (linear, since the camera never tilts)
const toWorld = (sx, sy) => ({ x: (sx - W / 2) / ppu, y: (H / 2 - sy) / ppu });
const toScreen = (wx, wy) => ({ x: wx * ppu + W / 2, y: H / 2 - wy * ppu });

// place camera + canvas so the view is centred on her (rotated) centre of mass
function updateView() {
  const h = model.height;
  const c = Math.cos(pet.theta), sn = Math.sin(pet.theta);
  const ox = -sn * h * 0.5, oy = c * h * 0.5;
  let cx = pet.x + ox;
  let cy = pet.y + pet.bob + pet.crouch + oy + h * 0.12;
  // The canvas lands on whole device pixels. Translated by a fraction, the compositor resamples
  // her every frame she breathes, and her outline shimmers. The camera is then moved to match the
  // snapped canvas, so she does not shift inside it by the same fraction.
  const dpr = window.devicePixelRatio || 1;
  canvasLeft = Math.round((W / 2 + cx * ppu - CS / 2) * dpr) / dpr;
  canvasTop = Math.round((H / 2 - cy * ppu - CS / 2) * dpr) / dpr;
  cx = (canvasLeft + CS / 2 - W / 2) / ppu;
  cy = (H / 2 - canvasTop - CS / 2) / ppu;
  camera.position.set(cx, cy, camDist);
  camera.lookAt(cx, cy, 0);
  canvas.style.transform = fx.style.transform = `translate(${canvasLeft.toFixed(3)}px, ${canvasTop.toFixed(3)}px)`;
  // contact shadow: sits on the floor under her, fades as she rises
  const lift = clamp((pet.y - groundY) / (h * 0.9), 0, 1);
  shadow.position.set(pet.x + ox * 0.6, groundY + 0.004, 0.04);
  const sw = h * (0.55 + 0.25 * lift), sd = h * 0.32;
  shadow.scale.set(sw, sd, 1);
  shadow.material.opacity = 0.85 * (1 - lift) * (pet.state === 'sit' ? 1.1 : 1);
  shadow.visible = shadow.material.opacity > 0.02;
}

// ---------------------------------------------------------------- model
let model = null; // { vrm, bones, height, hipH, comY }
let springResetPending = 0;
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const BONE_NAMES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  // fingers: only used to grip the sign post
  ...['left', 'right'].flatMap((h) => ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
    .flatMap((f) => ['Proximal', 'Intermediate', 'Distal'].map((s) => h + f + s))),
];
// hit-test radii (world units, relative to a 1.6-unit-tall model)
const HIT_R = {
  head: 0.16, neck: 0.1, chest: 0.16, upperChest: 0.15, spine: 0.15, hips: 0.17,
  leftUpperArm: 0.07, leftLowerArm: 0.06, leftHand: 0.07, rightUpperArm: 0.07, rightLowerArm: 0.06, rightHand: 0.07,
  leftUpperLeg: 0.1, leftLowerLeg: 0.08, leftFoot: 0.08, rightUpperLeg: 0.1, rightLowerLeg: 0.08, rightFoot: 0.08,
};

async function loadModel(buffer, name) {
  const loadingEl = document.getElementById('loading');
  loadingEl.hidden = false; loadingEl.textContent = `Loading ${name}…`;
  try {
    const gltf = await loader.parseAsync(buffer, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('file is not a VRM');
    if (model) {
      scene.remove(model.root);
      VRMUtils.deepDispose(model.vrm.scene);
      model = null;
    }
    try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch {}
    try { VRMUtils.combineSkeletons(gltf.scene); } catch {}
    try { VRMUtils.combineMorphs(vrm); } catch {}
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });

    const bones = {};
    // The humanoid copies rotation from these normalized nodes onto the real skeleton every frame,
    // and nothing else — a scale set here would simply be ignored. Proportions therefore have to be
    // applied to the raw bones, so keep a handle on both.
    const rawBones = {};
    for (const n of BONE_NAMES) {
      const b = vrm.humanoid.getNormalizedBoneNode(n);
      if (b) { bones[n] = b; b.rotation.order = 'XYZ'; }
      const r = vrm.humanoid.getRawBoneNode(n);
      if (r) rawBones[n] = r;
    }
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const height = Math.max(0.5, box.max.y - box.min.y);
    const hipPos = new THREE.Vector3();
    bones.hips.getWorldPosition(hipPos);
    const hipH = hipPos.y - box.min.y;

    if (vrm.lookAt) { vrm.lookAt.target = lookTarget; vrm.lookAt.autoUpdate = true; }
    const root = new THREE.Group();
    root.rotation.order = 'ZYX';
    root.add(vrm.scene);
    scene.add(root);
    // VRM 0.x rigs are rotated 180° about Y relative to VRM 1.0, which flips the
    // sign of local X/Z bone rotations (Y is unchanged).
    const isVRM0 = vrm.meta?.metaVersion === '0';
    const joints = [];
    vrm.springBoneManager?.joints?.forEach((j) => joints.push({ j, g: j.settings.gravityPower }));
    const outlinePairs = applyLook(vrm, height);
    // proportions are always measured from the skeleton as its author left it
    const rest = { hipY: rawBones.hips ? rawBones.hips.position.y : 0, height, hipH };
    model = { vrm, root, bones, rawBones, rest, height, hipH, comY: height * 0.55, name, sign: isVRM0 ? -1 : 1, joints, gravityScale: 1, outlinePairs, mats: collectMaterials(vrm.scene) };
    fxApplied = false; canvas.style.filter = lastFilter = ''; pet.wounds = []; sparks.length = 0; woundTexKey = '';
    disposeSign();
    // figure: VRoid-style bust bones (J_Sec_*_Bust1 -> Bust2) carry the chest vertices and have their own spring group
    const bustNodes = [];
    vrm.scene.traverse((o) => { if (/bust/i.test(o.name) && !/bust2|bust_end/i.test(o.name)) bustNodes.push(o); });
    const bustJoints = (vrm.springBoneManager?.joints ? [...vrm.springBoneManager.joints] : []).filter((j) => /bust/i.test(j.bone.name))
      .map((j) => ({ j, stiffness: j.settings.stiffness, drag: j.settings.dragForce }));
    model.bust = { nodes: bustNodes, joints: bustJoints, rest: bustNodes.map((n) => n.quaternion.clone()), avg: [] };
    // Where the bust hangs decides whether a waist change drags it along: some rigs parent it to
    // the chest, others to the upper chest.
    model.bustUnderChest = false;
    for (let p = bustNodes[0]; p; p = p.parent) {
      if (p === rawBones.upperChest) break;
      if (p === rawBones.chest) { model.bustUnderChest = true; break; }
    }
    bridge.log(`bust rig: ${bustNodes.length} bones, ${bustJoints.length} spring joints`);
    const skirtNodes = [];
    vrm.scene.traverse((o) => { if (/Skirt/i.test(o.name) && !/_end$/i.test(o.name) && !/\d/.test(o.name)) skirtNodes.push(o); });
    model.skirt = skirtNodes;
    model.figure = figureMaterials(vrm); figureTexKey = '';
    bridge.log(`figure materials: ${Object.keys(model.figure).join(',') || 'none'}; skirt bones: ${skirtNodes.length}`);
    applyFigure(); applyFigureTextures();
    const em = vrm.expressionManager;
    bridge.log(`expressions: ${em ? em.expressions.map((e) => e.expressionName).join(',') : 'none'}; vrm0=${isVRM0}`);
    for (const n in poseCur) delete poseCur[n];
    for (const n in exprAlias) delete exprAlias[n];
    layout();
    pet.onGround = true; pet.y = groundY; pet.theta = 0; pet.omega = 0; pet.vx = 0; pet.vy = 0;
    setState('idle');
    // place the root before resetting springs so hair doesn't inherit a teleport
    root.position.set(pet.x, pet.y, 0);
    root.updateMatrixWorld(true);
    vrm.springBoneManager?.reset();
    springResetPending = 2;
    bridge.log(`loaded ${name} (${height.toFixed(2)}u tall, ${Object.keys(bones).length} bones)`);
    bridge.modelReady();
    if (cfg && !cfg.tourDone && !tourActive) setTimeout(startTour, 900);
  } catch (e) {
    bridge.log(`load failed: ${e.message}`);
    loadingEl.textContent = `Failed to load model: ${e.message}`;
    setTimeout(() => { if (loadingEl.textContent.startsWith('Failed')) loadingEl.hidden = true; }, 6000);
    bridge.modelFailed();
    return;
  }
  loadingEl.hidden = true;
}

// ---------------------------------------------------------------- settings & voice
let cfg = null;                 // full settings object from the main process
let audioCtx = null, voice = null;
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    voice = createVoice(audioCtx, { volume: cfg?.volume ?? 0.6, pitch: cfg?.pitch ?? 1 });
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return voice;
}
const soundCooldown = {};
let lastSoundAt = -9;
// play the phrase the user assigned to an event (see settings panel)
function soundFile(name) { return (cfg?.soundFiles || []).find((f) => f.name === name); }
function playFile(f, volume = 1) {
  try {
    // the desktop app hands over absolute paths; the web build hands over plain URLs
    const p = (f.path || '').replace(/\\/g, '/');
    const a = new Audio(f.url || 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p));
    logSound(f.name);
    a.volume = clamp((cfg?.volume ?? 0.6) * volume, 0, 1);
    a.playbackRate = clamp(cfg?.pitch ?? 1, 0.5, 2);
    try { a.preservesPitch = false; a.mozPreservesPitch = false; } catch {}
    a.play().catch((e) => bridge.log('file sound: ' + e.message));
  } catch (e) { bridge.log('file sound: ' + e.message); }
}
// play whatever is assigned to an event: a synthesised phrase, or "file:name.wav" from the sounds folder
function playAssigned(name, volume = 1) {
  if (!name) return;
  if (name.startsWith('file:')) { const f = soundFile(name.slice(5)); if (f) playFile(f, volume); return; }
  const ph = PHRASES[name];
  if (ph) try { logSound(name); ensureAudio().play(ph.seq, { pitch: cfg?.pitch ?? 1, volume }); } catch (e) { bridge.log('sound: ' + e.message); }
}
// Quiet mode: each kind of noise has its own switch, and "do not disturb" silences all of them
// until a time. She keeps tracking trades and standing there either way.
const dndOn = () => !!cfg && Number(cfg.dndUntil) > Date.now();
const quiet = (kind) => !cfg || dndOn() || cfg['quiet' + kind] === true;   // kind: Bubbles | Reactions | Board | Sounds
function sound(event, o = {}) {
  if (!cfg || cfg.muted || quiet('Sounds')) return;
  const name = (cfg.sounds || {})[event];
  if (!name) return;
  if (T - (soundCooldown[event] ?? -99) < (o.cooldown ?? 0.3)) return;
  if (T - lastSoundAt < 0.15) return;
  soundCooldown[event] = T; lastSoundAt = T;
  playAssigned(name, o.volume ?? 1);
}
function playPhrase(name) { playAssigned(name); }
// The self-test reads this back; keep only the recent tail so a long stream cannot grow it forever.
function logSound(name) {
  const a = (window.__petSounds ||= []);
  a.push(name);
  if (a.length > 400) a.splice(0, a.length - 400);
}
const LOOK_KEYS = new Set(['bust', 'jiggle', 'cleavage', 'skirtLen', 'hips', 'waist', 'thighs', 'headSize', 'outfit', 'topStyle', 'bottomStyle', 'bow', 'hairColor', 'eyeColor', 'customVest', 'customSkirt', 'customBow']);
function saveCfg(patch) {
  if (!cfg) return;
  if (Object.keys(patch).some((k) => LOOK_KEYS.has(k))) tourFlag('look');
  if (patch.sounds) cfg.sounds = { ...cfg.sounds, ...patch.sounds };
  Object.assign(cfg, patch.sounds ? { ...patch, sounds: cfg.sounds } : patch);
  if (voice && ('volume' in patch || 'pitch' in patch)) voice.set({ volume: cfg.volume, pitch: cfg.pitch });
  bridge.saveSettings(patch);
}
const herName = () => 'Yui';
window.__petOutfits = () => Object.keys(OUTFITS);
window.__petOutline = (scale) => {
  OUTLINE_SCALE = scale;
  if (!model) return;
  for (const [surf, outline] of model.outlinePairs || []) {
    surf.outlineWidthFactor = outline.outlineWidthFactor = model.height * scale;
    surf.needsUpdate = outline.needsUpdate = true;
  }
};

// ---------------------------------------------------------------- speech bubble
const bubbleEl = document.getElementById('bubble');
let bubbleUntil = -1;
let bubbleW = 200, bubbleH = 40;   // measured once per message, not per frame (that forces a reflow)
// `tone` colours the bubble's bloom: 1 for good news (a win), -1 for bad (a loss), 0 for anything else.
function say(text, secs, tone = 0) {
  // Nothing to speak from until she is on screen: shown now, the bubble would sit at the window's
  // top-left corner until the next frame found a head to hang it on.
  if (!bubbleEl || !model || quiet('Bubbles')) return;
  bubbleEl.textContent = text;
  bubbleEl.classList.toggle('good', tone > 0);
  bubbleEl.classList.toggle('bad', tone < 0);
  // re-trigger the pop when she speaks again while a bubble is already up
  bubbleEl.classList.remove('show'); void bubbleEl.offsetWidth;
  bubbleEl.classList.add('show');
  bubbleW = bubbleEl.offsetWidth || bubbleW; bubbleH = bubbleEl.offsetHeight || bubbleH;
  bubbleUntil = T + (secs ?? Math.min(9, 2.2 + text.length * 0.07));
  updateBubble();   // placed before it is ever painted, so it never flashes at its last position
}
function updateBubble() {
  if (!bubbleEl || bubbleUntil < 0) return;
  if (T > bubbleUntil || !model) { bubbleEl.classList.remove('show'); bubbleUntil = -1; return; }
  // The bubble hangs off her crown along her own "up" — the head-from-neck direction on screen —
  // so it stays over her head however she is tilted, and goes under it when she hangs head-down.
  // The head bone sits at her chin, so the distance is a bit more than half a head; the Head
  // slider scales the head and hair, so the distance scales with it.
  const hp = boneScreen('head'), np = boneScreen('neck') || boneScreen('upperChest') || boneScreen('chest');
  if (!hp) return;
  let ux = 0, uy = -1;
  if (np) { const dx = hp.x - np.x, dy = hp.y - np.y, l = Math.hypot(dx, dy) || 1; ux = dx / l; uy = dy / l; }
  const headScale = (model.rawBones && model.rawBones.head && model.rawBones.head.scale.y) || 1;
  const R = model.height * 0.155 * headScale * ppu;
  const below = uy > 0.35;                         // hanging head-down: bubble under the head, tail up
  bubbleEl.classList.toggle('below', below);
  let ax = hp.x + ux * R, ay = hp.y + uy * R;
  // a board held high can sit in front of her face: lift the bubble clear of it rather than aside
  const box = signScreenBox();
  if (box && !below && ax + bubbleW / 2 > box.l && ax - bubbleW / 2 < box.r && ay > box.t - 12 && ay - bubbleH < box.b) ay = box.t - 12;
  const bx = clamp(ax, bubbleW / 2 + 8, W - bubbleW / 2 - 8);
  const top = below ? clamp(ay + 10, 8, H - bubbleH - 8) : clamp(ay - 8, bubbleH + 14, H - 8);
  bubbleEl.style.left = `${bx.toFixed(1)}px`;
  bubbleEl.style.top = `${top.toFixed(1)}px`;
}

// what she says (sym, amount, pct) — no lorem, she's talking about your trade
// The last argument of every line is the user's name, or '' before they have given one; each line
// reads naturally either way. The name is what she was told in the tour (Her tab to change it).
const who = () => String(cfg?.userName || '').trim().slice(0, 24);
const line = (list, ...args) => pick(list)(...args, who());
const LINES = {
  greet: [
    (n, y) => y ? `Hi ${y}! It's ${n}~` : `Hi! I'm ${n}~`, (n, y) => y ? `${n} here, ${y}. Need something?` : `${n} here. Need something?`,
    (n, y) => y ? `Ehehe, hello ${y}!` : `Ehehe, hello!`, (n, y) => y ? `Un! I'm watching, ${y}~` : `Un! I'm watching~`,
  ],
  buy: [
    (s, a, y) => y ? `Ooh ${y}, ${s}! ${a} in. Good luck~` : `Ooh, ${s}! ${a} in. Good luck~`, (s, a, y) => `New position: ${s}. Watching it with you${y ? ', ' + y : ''}!`,
    (s, a, y) => `${s}? Interesting choice${y ? ', ' + y : ''}…`, (s, a, y) => `${a} into ${s}. Let's go${y ? ', ' + y : ''}~`,
  ],
  profit: [
    (s, a, p, y) => y ? `Good job ${y}! ${a} on ${s}~` : `Nice trade! ${a} on ${s}~`, (s, a, p, y) => `${s} paid out${y ? ', ' + y : ''}! ${a}!`,
    (s, a, p, y) => `You did it${y ? ', ' + y : ''}! ${a}~`, (s, a, p, y) => `Ehehe, ${a}. That's ${p.toFixed(0)}%${y ? ', ' + y : ''}!`,
    (s, a, p, y) => `Clean${y ? ', ' + y : ''}. ${a} on ${s}.`,
  ],
  bigProfit: [
    (s, a, p, y) => `WAAA ${y ? y + '! ' : ''}${a} on ${s}!!`, (s, a, p, y) => `That's huge${y ? ', ' + y : ''}! ${a}, ${p.toFixed(0)}%!`,
    (s, a, p, y) => `${a}?! ${y ? y + ', you' : 'You'}'re amazing!`,
  ],
  loss: [
    (s, a, p, y) => `It's okay${y ? ' ' + y : ''}… only ${a} on ${s}. Next one.`, (s, a, p, y) => `${s} was a bad one. You're still good${y ? ', ' + y : ''}.`,
    (s, a, p, y) => `Mm… ${a}. I'm here${y ? ', ' + y : ''}, okay?`, (s, a, p, y) => `Losses happen${y ? ', ' + y : ''}. Breathe~`, (s, a, p, y) => `${a}. Don't chase it${y ? ', ' + y : ''}.`,
  ],
  bigLoss: [
    (s, a, p, y) => `…${a}. Come here${y ? ', ' + y : ''}. It's going to be fine.`, (s, a, p, y) => `That hurt. Take a break${y ? ', ' + y : ''}, I'll wait here.`,
    (s, a, p, y) => `${a} on ${s}… it's just one trade${y ? ', ' + y : ''}. You're not done.`,
  ],
  flat: [
    (s, a, y) => `Flat on ${s}. Clean exit${y ? ', ' + y : ''}~`, (s, a, y) => `Sold ${s} for ${a}. Even${y ? ', ' + y : ''}.`, (s, a, y) => `${s} closed. No harm done${y ? ', ' + y : ''}.`,
  ],
};

// ---------------------------------------------------------------- relay (trade feed)
let relay = null, relayStatus = 'off', relayInfo = '', relayRetry = 0, relayTimer = null, relayLastMsg = 0, relayHeartbeats = false;
// A healthy connection says nothing about whether the wallet you typed is the one you trade from,
// so count what actually arrives and show it: 'no trades yet' is the symptom of a wrong address.
let relayTrades = 0, relayLastTradeAt = 0;
const RELAY_STALE_MS = 75000; // the relay sends a status heartbeat every 25 s
setInterval(() => {
  // only once this relay has proven it sends heartbeats (older relays don't; never flap on them)
  if (!relayHeartbeats || !relay || relay.readyState !== WebSocket.OPEN || Date.now() - relayLastMsg < RELAY_STALE_MS) return;
  const dead = relay; relay = null;
  try { dead.close(); } catch {}
  relayStatus = 'off'; relayInfo = 'Connection went quiet'; refreshRelayStatus();
  if (cfg && cfg.autoConnect) scheduleReconnect();
}, 15000);
window.addEventListener('online', () => { if (cfg && cfg.autoConnect && !relay) { relayRetry = 0; connectRelay(); } });
function walletsList() { return ((cfg && cfg.wallets) || '').split(/[\s,]+/).filter(Boolean); }
function connectRelay() {
  if (!cfg) return;
  const wallets = walletsList();
  if (!wallets.length) { relayStatus = 'err'; relayInfo = 'Enter a wallet address first.'; refreshRelayStatus(); return; }
  disconnectRelay(true);
  let url;
  try { url = new URL(cfg.relayUrl); } catch { relayStatus = 'err'; relayInfo = 'Relay URL is not valid.'; refreshRelayStatus(); return; }
  url.searchParams.set('token', cfg.relayToken || '');
  url.searchParams.set('wallets', wallets.join(','));
  relayStatus = 'connecting'; relayInfo = 'Connecting…'; refreshRelayStatus();
  let ws;
  try { ws = new WebSocket(url.toString()); } catch (e) { relayStatus = 'err'; relayInfo = e.message; refreshRelayStatus(); return; }
  relay = ws;
  ws.onopen = () => { relayRetry = 0; relayLastMsg = Date.now(); relayHeartbeats = false; relayInfo = 'Connected, loading positions…'; refreshRelayStatus(); };
  ws.onmessage = (ev) => {
    relayLastMsg = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try { handleRelay(m); } catch (e) { bridge.log('relay message failed: ' + e.message); }
  };
  ws.onerror = () => { relayInfo = 'Connection failed (is the relay running / reachable?)'; relayStatus = 'err'; refreshRelayStatus(); };
  ws.onclose = (ev) => {
    if (relay !== ws) return;
    relay = null;
    if (relayStatus !== 'err') { relayStatus = 'off'; relayInfo = ev.reason ? `Disconnected: ${ev.reason}` : 'Disconnected'; }
    refreshRelayStatus();
    if (cfg.autoConnect && ev.code !== 1008) scheduleReconnect();
  };
}
function scheduleReconnect() {
  clearTimeout(relayTimer);
  const d = Math.min(30000, 1000 * 2 ** relayRetry++);
  relayInfo += ` · retrying in ${Math.round(d / 1000)}s`; refreshRelayStatus();
  relayTimer = setTimeout(() => connectRelay(), d);
}
function disconnectRelay(silent) {
  clearTimeout(relayTimer);
  if (relay) { const w = relay; relay = null; try { w.close(); } catch {} }
  relayStatus = 'off';
  if (!silent) { relayInfo = 'Disconnected'; refreshRelayStatus(); }
}
// Everything below arrives from a relay — possibly someone else's, possibly out of date, possibly
// wrong. Coerce it before it can reach the running totals: a single bad field would otherwise turn
// the session PnL into NaN, or into a string, for the rest of the run.
// null/undefined/"" must stay absent: Number(null) is 0, which would read as a realised zero
const fin = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
// The live SOL price, as the relay last reported it. Market caps arrive in dollars already; this is
// only for turning a SOL-equivalent PnL into dollars on a dollar-quoted coin, and for the fallback.
let liveSolUsd = 0;
const noteSolUsd = (m) => { const v = fin(m && m.solUsd); if (v > 0) liveSolUsd = v; };
const QUOTE_KINDS = new Set(['sol', 'usd', 'other']);
const VENUES = { 'pump.fun': 'pump.fun', 'pump.swap': 'PumpSwap', launchlab: 'LaunchLab', stonkfun: 'stonkfun', bonk: 'Bonk', raydium: 'Raydium', meteora: 'Meteora' };
function cleanTrade(m) {
  m.side = m.side === 'sell' ? 'sell' : 'buy';
  m.mint = str(m.mint, 64) || '';
  m.symbol = str(m.symbol, 24);
  m.quote = m.quote === 'USDC' ? 'USDC' : 'SOL';
  // an older relay says quote:'USDC' with dollar amounts; the current one says quote:'SOL' (SOL-
  // equivalent) and tells us what the pair was really quoted in via quoteKind
  m.quoteKind = QUOTE_KINDS.has(m.quoteKind) ? m.quoteKind : m.quote === 'USDC' ? 'usd' : 'sol';
  m.quoteSymbol = str(m.quoteSymbol, 16);
  m.venue = VENUES[m.venue] ? m.venue : null;
  m.amount = Math.max(0, fin(m.amount) ?? 0);
  m.tokens = Math.max(0, fin(m.tokens) ?? 0);
  m.pnl = fin(m.pnl); m.pnlPct = fin(m.pnlPct);           // null when the relay has no cost basis
  m.mcQuote = fin(m.mcQuote); m.mcUsd = fin(m.mcUsd);
  m.remainingTokens = fin(m.remainingTokens); m.remainingCost = fin(m.remainingCost);
  noteSolUsd(m);
  return m;
}
function cleanPosition(p) {
  return {
    mint: str(p && p.mint, 64) || '', symbol: str(p && p.symbol, 24),
    tokens: Math.max(0, fin(p && p.tokens) ?? 0), cost: Math.max(0, fin(p && p.cost) ?? 0),
    quote: (p && p.quote) === 'USDC' ? 'USDC' : 'SOL',
  };
}
function handleRelay(m) {
  noteSolUsd(m);
  if (m.type === 'hello') {
    relayStatus = 'ok';
    positions.clear(); // the relay is authoritative for what is open (session totals survive a reconnect)
    for (const raw of Array.isArray(m.positions) ? m.positions : []) {
      const p = cleanPosition(raw);
      if (!p.mint) continue;
      applyPosition(p.mint, { tokens: p.tokens, cost: p.cost, quote: p.quote, symbol: p.symbol, at: T, live: liveMints.has(p.mint) });
    }
    // a relay that answers without these fields must not throw its way out of onmessage
    const n = (Array.isArray(m.wallets) ? m.wallets : walletsList()).length;
    const p = Array.isArray(m.positions) ? m.positions.length : 0;
    relayInfo = `Live · ${n} wallet${n > 1 ? 's' : ''}, ${p} open position${p === 1 ? '' : 's'}${m.firehose ? '' : ' · firehose down'}`;
    refreshRelayStatus();
    sound('connect');
    tourFlag('wallet');
    say(`Connected! Watching ${n} wallet${n > 1 ? 's' : ''}~`);
  } else if (m.type === 'status') {
    if (m.heartbeat) { relayHeartbeats = true; return; } // periodic keep-alive, nothing changed
    relayInfo = m.firehose ? 'Live' : 'Relay up, firehose down…'; refreshRelayStatus();
  } else if (m.type === 'price') {
    const p = positions.get(str(m.mint, 64) || '');
    if (p) {
      const mc = fin(m.mcQuote), price = fin(m.price), mcUsd = fin(m.mcUsd);
      if (mc > 0) p.mc = mc;                 // the honest, quote-agnostic mark
      if (mcUsd > 0) p.mcUsd = mcUsd;
      if (price > 0) p.price = price;
      if (m.quote === 'USDC' || m.quote === 'SOL') p.quote = m.quote;
      if (QUOTE_KINDS.has(m.quoteKind)) p.quoteKind = m.quoteKind;
      marketWatch(p);
    }
  } else if (m.type === 'trade') {
    cleanTrade(m);
    if (!m.mint) return;
    relayTrades++; relayLastTradeAt = Date.now(); refreshRelayStatus();
    trackTrade(m);
    tourFlag('trade');
    reactToTrade(m);
  } else if (m.type === 'error') {
    relayStatus = 'err'; relayInfo = str(m.message, 200) || 'The relay refused the connection.'; refreshRelayStatus();
  }
}
function refreshRelayStatus() {
  const sub = panelEl && panelEl.querySelector('.hd .sub');
  if (sub) { sub.textContent = relayStatus === 'ok' ? 'connected' : relayStatus === 'err' ? 'not connected' : 'settings'; sub.classList.toggle('live', relayStatus === 'ok'); }
  const el = panelEl && panelEl.querySelector('#relayStatus');
  if (el) { el.textContent = relayInfo; el.className = 'status ' + (relayStatus === 'ok' ? 'ok' : relayStatus === 'err' ? 'err' : ''); }
  const b = panelEl && panelEl.querySelector('#btnConnect');
  if (b) b.textContent = relay ? 'Disconnect' : 'Connect';
  const t = panelEl && panelEl.querySelector('#relayTrades');
  if (t) { t.textContent = tradesSeenText(); t.className = 'status' + (relayStatus === 'ok' && !relayTrades ? ' warn' : ''); t.hidden = relayStatus !== 'ok'; }
}
function tradesSeenText() {
  if (!relayTrades) return 'No trades seen yet — she reacts when the address above buys or sells. If you trade from a different wallet (Axiom and Photon make their own), add that one too.';
  const secs = Math.max(0, Math.round((Date.now() - relayLastTradeAt) / 1000));
  const ago = secs < 60 ? secs + 's ago' : secs < 3600 ? Math.round(secs / 60) + 'm ago' : Math.round(secs / 3600) + 'h ago';
  return `${relayTrades} trade${relayTrades === 1 ? '' : 's'} seen this session · last ${ago}`;
}

const fmtNum = (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(3));
// keep the open positions and the session total in step with our own fills
function trackTrade(m) {
  demoPos = null; // a real fill takes the board back
  // realised totals only make sense summed in one currency; SOL is the pair for almost everything
  lastTradeAt = T;
  if (m.pnl != null && (m.quote || 'SOL') === 'SOL') { sessionPnl += m.pnl; sessionTrades++; }
  const prev = positions.get(m.mint);
  const mc = Number(m.mcQuote) > 0 ? Number(m.mcQuote) : 0;
  let invSum = (prev && prev.invSum) || 0;
  if (m.side === 'buy') {
    if (mc > 0 && m.amount > 0) invSum += m.amount / mc;       // tokens bought, in market-cap terms
  } else if (prev && prev.tokens > 0) {
    invSum *= clamp((m.remainingTokens ?? 0) / prev.tokens, 0, 1); // sell the same fraction of the basis
  }
  let remaining = m.remainingTokens ?? 0;
  // a sell that leaves a sliver (a venue's fee taken from the token side) is a full exit
  if (m.side === 'sell' && prev && prev.tokens > 0 && remaining > 0 && remaining <= prev.tokens * 0.03) remaining = 0;
  const o = { tokens: remaining, cost: remaining > 0 ? (m.remainingCost ?? 0) : 0, quote: m.quote, quoteKind: m.quoteKind, venue: m.venue, symbol: m.symbol, at: T, live: true, invSum };
  if (m.mcUsd > 0) o.mcUsd = m.mcUsd;
  if (o.tokens > 0) liveMints.add(m.mint); else liveMints.delete(m.mint);
  if (mc > 0) o.mc = mc;
  const price = m.tokens > 0 ? m.amount / m.tokens : 0;
  if (price > 0) o.price = price;
  applyPosition(m.mint, o);
  recordFill(m);
}
function reactToTrade(t) {
  const sym = t.symbol ? `$${t.symbol}` : `${(t.mint || '').slice(0, 4)}…`;
  const money = (n) => signMoney(n, t.quote, t.quoteKind);
  pet.lastInteraction = T;
  // asleep: the jolt awake is the reaction this time (she still says her line)
  const woke = pet.state === 'sleep';
  if (woke) setState('wake');
  const busy = pet.state === 'grabbed' || pet.state === 'falling' || woke;
  // reactions off (quiet mode / do not disturb): the numbers still move, she does not
  const react = !quiet('Reactions');
  const y = who();
  if (t.side === 'buy') {
    // buying back a coin sold at a loss a moment ago: she does not stop you, she just looks at you
    const ls = t.mint && lastLossSell.get(t.mint);
    if (react && cfg?.guard !== false && ls && T - ls.at < GUARD_WINDOW) {
      sound('hover', { cooldown: 1 });
      say(pick([`…are you sure${y ? ', ' + y : ''}?`, `${sym} again? You just took a loss on it${y ? ', ' + y : ''}…`, `Chasing it${y ? ', ' + y : ''}? Mm.`]), 5, -1);
      if (!busy) setState('guard');
      return;
    }
    sound('buy', { cooldown: 1.4 }); say(line(LINES.buy, sym, money(t.amount)));
    if (react && !busy) setState('notice');
    return;
  }
  const pnl = t.pnl;
  if (pnl == null) { sound('sell'); say(`Sold ${sym} for ${money(t.amount)}~`); if (react && !busy) setState('notice'); return; }
  const pct = t.pnlPct ?? 0;
  const thr = t.quote === 'USDC' ? 3 : 0.02;
  if (pnl >= thr) {
    const big = (t.quote === 'USDC' ? pnl >= 150 : pnl >= 1) || pct >= 100;
    sound(big ? 'bigProfit' : 'profit', { cooldown: 1.2 });
    say(line(big ? LINES.bigProfit : LINES.profit, sym, '+' + money(pnl), pct), undefined, 1);
    moodShift(big ? 0.5 : 0.35);
    if (react && !busy) { pet.happy = 1; setState('cheer'); }
    if (react) { addGlow(big ? 1 : 0.7); healHurt(big ? 0.6 : 0.35); }
  } else if (pnl <= -thr) {
    const big = (t.quote === 'USDC' ? pnl <= -150 : pnl <= -1) || pct <= -50;
    sound(big ? 'bigLoss' : 'loss', { cooldown: 1.2 });
    say(line(big ? LINES.bigLoss : LINES.loss, sym, '−' + money(pnl), pct), undefined, -1);
    moodShift(big ? -0.5 : -0.35);
    if (react && !busy) setState('comfort');
    if (react) addHurt(big ? 0.75 : 0.45);
  } else {
    sound('sell', { cooldown: 1.2 }); say(line(LINES.flat, sym, money(t.amount)));
    if (react && !busy) setState('notice');
  }
  if (react) checkMilestones(t);
}

// ---------------------------------------------------------------- mood
// A win streak leaves her bouncy for an hour; a run of losses leaves her quiet and worried until
// the next green. It decays back to neutral on its own and colours her fidgets, face and greetings.
function moodShift(d) { pet.mood = clamp(pet.mood + d, -1, 1); }
const moodUp = () => pet.mood > 0.4, moodDown = () => pet.mood < -0.4;

// ---------------------------------------------------------------- the "don't chase" look
const GUARD_WINDOW = 60;   // seconds after a losing sell in which buying the same coin earns the look
const lastLossSell = new Map();   // mint -> { at, pnl }

// ---------------------------------------------------------------- the day's numbers, streaks, milestones
// Kept in settings so a restart mid-day does not lose them; rolled over at midnight, when the
// previous day's card is shown for a moment.
const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function freshStats(day) { return { day, trades: 0, pnl: 0, wins: 0, losses: 0, best: null, worst: null, streak: 0 }; }
function dayStats() {
  if (!cfg) return freshStats(dayKey());
  const today = dayKey();
  if (!cfg.stats || cfg.stats.day !== today) {
    const prev = cfg.stats && cfg.stats.trades > 0 ? cfg.stats : null;
    saveCfg({ stats: freshStats(today), yesterday: prev || cfg.yesterday || null });
    if (prev && model) showScorecard(prev, 'YESTERDAY');   // the day just ended: here is how it went
  }
  return cfg.stats;
}
// a realised fill (sell with a pnl), in SOL-equivalent
function recordFill(m) {
  if (!cfg) return;
  if (m.side === 'sell' && m.pnl != null && m.pnl < 0) lastLossSell.set(m.mint, { at: T, pnl: m.pnl });
  const st = dayStats();
  const total = (Number(cfg.totalTrades) || 0) + 1;
  if (m.side === 'sell' && m.pnl != null && (m.quote || 'SOL') === 'SOL') {
    st.trades++; st.pnl += m.pnl;
    const sym = m.symbol ? '$' + m.symbol : m.mint.slice(0, 4) + '…';
    if (m.pnl > 0) { st.wins++; st.streak = st.streak > 0 ? st.streak + 1 : 1; if (!st.best || m.pnl > st.best.pnl) st.best = { sym, pnl: m.pnl }; }
    else if (m.pnl < 0) { st.losses++; st.streak = st.streak < 0 ? st.streak - 1 : -1; if (!st.worst || m.pnl < st.worst.pnl) st.worst = { sym, pnl: m.pnl }; }
  }
  saveCfg({ stats: st, totalTrades: total });
}
// something worth a confetti cannon
function checkMilestones(t) {
  if (!cfg || !cfg.stats) return;
  const st = cfg.stats, ms = { ...(cfg.milestones || {}) }, y = who();
  let text = null;
  if (st.streak >= 5 && ms.streak !== st.day) { ms.streak = st.day; text = `${st.streak} greens in a row${y ? ', ' + y : ''}!!`; }
  else if (st.pnl >= 1 && !ms.solDay) { ms.solDay = st.day; text = `Your first 1 SOL day${y ? ', ' + y : ''}!!`; }
  else if ([100, 500, 1000, 5000].includes(cfg.totalTrades) && ms.trades !== cfg.totalTrades) { ms.trades = cfg.totalTrades; text = `${cfg.totalTrades} trades together${y ? ', ' + y : ''}~`; }
  if (!text) return;
  saveCfg({ milestones: ms });
  celebrate(text);
}
function celebrate(text) {
  sound('bigProfit', { cooldown: 0 });
  say(text, 6, 1);
  moodShift(0.4);
  addGlow(1);
  spawnConfetti(70);
  if (pet.state !== 'grabbed' && pet.state !== 'falling') { pet.happy = 1; setState('cheer'); }
}

// ---------------------------------------------------------------- the scorecard
let scorecardUntil = -1, scorecardTitle = 'TODAY', scorecardStats = null;
function showScorecard(st, title = 'TODAY') {
  scorecardStats = st || dayStats(); scorecardTitle = title; scorecardUntil = T + 30;
  signDismissedId = null;
  const y = who();
  const wr = scorecardStats.trades ? Math.round(scorecardStats.wins / scorecardStats.trades * 100) : 0;
  const sign = scorecardStats.pnl >= 0 ? '+' : '−';
  if (!scorecardStats.trades) say(`No trades ${title === 'TODAY' ? 'yet today' : 'yesterday'}${y ? ', ' + y : ''}~`, 4);
  else say(`${title === 'TODAY' ? 'Today' : 'Yesterday'}: ${scorecardStats.trades} trade${scorecardStats.trades === 1 ? '' : 's'}, ${sign}${fmtNum(Math.abs(scorecardStats.pnl))} SOL, ${wr}% wins${y ? '. Nice work, ' + y : ''}~`, 6, scorecardStats.pnl > 0 ? 1 : scorecardStats.pnl < 0 ? -1 : 0);
}
function scorecardContent() {
  const st = scorecardStats || freshStats(dayKey());
  const wr = st.trades ? Math.round(st.wins / st.trades * 100) : 0;
  const foot = [st.best ? `best ${st.best.sym} +${fmtNum(st.best.pnl)}` : null, st.worst ? `worst ${st.worst.sym} −${fmtNum(Math.abs(st.worst.pnl))}` : null].filter(Boolean).join(' · ') || null;
  return {
    id: 'day', title: scorecardTitle,
    amount: (st.pnl >= 0 ? '+' : '\u2212') + signMoney(st.pnl, 'SOL'),
    sub: `${st.trades} trade${st.trades === 1 ? '' : 's'} · ${wr}% wins`,
    foot, tone: st.pnl > 1e-9 ? 1 : st.pnl < -1e-9 ? -1 : 0,
  };
}

// ---------------------------------------------------------------- the sell nudge
// "You've held $X for 42 min and it's +80% — just saying." Thresholds live in the Board tab.
function sellNudges() {
  if (!cfg || quiet('Bubbles') || relayStatus !== 'ok') return;
  const pctThr = Number(cfg.nudgePct) > 0 ? Number(cfg.nudgePct) : 50, minThr = Number(cfg.nudgeMin) > 0 ? Number(cfg.nudgeMin) : 30;
  for (const p of positions.values()) {
    if (!(p.tokens > 0) || !p.live || !(p.openedAt > 0)) continue;
    const heldMin = (T - p.openedAt) / 60;
    const c = buildPositionContent(p);
    const pct = c.pct;
    if (pct >= pctThr && heldMin >= minThr && T - (p.nudgedAt || -9999) > 1200) {
      p.nudgedAt = T;
      const y = who();
      say(`You've held ${c.title} for ${Math.round(heldMin)} min and it's +${pct.toFixed(0)}%${y ? ', ' + y : ''} — just saying~`, 7, 1);
      if (pet.state === 'idle') setState('notice');
      return;
    }
  }
}

// ---------------------------------------------------------------- reacting to the market
// A coin she holds pumping or dumping gets a reaction of its own — the board swaps to it, and she
// gasps (2×, 3×, 5×, 10×) or winces (−40 %, −70 %, or giving most of a run back).
function marketWatch(p) {
  if (!p.live || !(p.tokens > 0) || quiet('Reactions')) return;
  const c = buildPositionContent(p);
  const pct = c.pct;
  p.peakPct = Math.max(p.peakPct || 0, pct);
  const y = who(), sym = c.title;
  const now = T;
  const gaspLevel = pct >= 900 ? 4 : pct >= 400 ? 3 : pct >= 200 ? 2 : pct >= 100 ? 1 : 0;
  const dumpLevel = pct <= -70 ? 2 : pct <= -40 ? 1 : 0;
  const gaveBack = p.peakPct >= 80 && p.peakPct - pct >= 60 && !p.gaveBackAt;
  const calm = pet.state === 'idle' || pet.state === 'sit' || pet.state === 'walk' || pet.state === 'notice';
  if (gaspLevel > (p.gaspLevel || 0) && now - (p.gaspAt || -999) > 90) {
    p.gaspLevel = gaspLevel; p.gaspAt = now; p.at = T;
    const x = ['', '2', '3', '5', '10'][gaspLevel];
    sound('bigProfit', { cooldown: 20, volume: 0.8 });
    say(pick([`${sym} is ${x}×${y ? ', ' + y : ''}!!`, `Look at ${sym}! ${x}×!`, `${y ? y + '! ' : ''}${sym} just went ${x}×!`]), 6, 1);
    moodShift(0.2);
    if (calm) setState('gasp');
  } else if ((dumpLevel > (p.dumpLevel || 0) || gaveBack) && now - (p.winceAt || -999) > 120) {
    if (gaveBack) p.gaveBackAt = now; else p.dumpLevel = dumpLevel;
    p.winceAt = now; p.at = T;
    sound('loss', { cooldown: 20, volume: 0.7 });
    say(gaveBack ? pick([`${sym} is giving it back${y ? ', ' + y : ''}…`, `Mm, ${sym} was +${p.peakPct.toFixed(0)}%…`])
      : pick([`${sym} is dumping${y ? ', ' + y : ''}…`, `Ehh, ${sym}… ${pct.toFixed(0)}%.`, `${sym}… hang in there${y ? ', ' + y : ''}.`]), 6, -1);
    moodShift(-0.15);
    if (calm) setState('wince');
  }
}

// ---------------------------------------------------------------- once a frame, quietly
let companionTimer = 0, lateSaidAt = -9999;
function companionTick(dt) {
  if (!cfg || !model) return;
  pet.mood *= Math.exp(-dt / 3600);           // an hour to fade
  companionTimer += dt;
  if (companionTimer < 5) return;
  companionTimer = 0;
  dayStats();                                  // rolls the day over when it changes
  // first sight of the day
  const today = dayKey();
  if (settingsApplied && cfg.lastGreetDay !== today && !tourActive && T > 3) {
    saveCfg({ lastGreetDay: today });
    const h = new Date().getHours(), y = who();
    const g = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    say(`${g}${y ? ', ' + y : ''}~ ${moodDown() ? 'Better day today, okay?' : "Let's do well today!"}`, 5);
    if (pet.state === 'idle') setState('wave');
  }
  // the small hours
  const hour = new Date().getHours();
  if (hour >= 1 && hour < 5 && T - lateSaidAt > 1800 && !quiet('Bubbles')) {
    lateSaidAt = T;
    const y = who();
    say(pick([`It's ${hour}am${y ? ', ' + y : ''}… go to sleep.`, `${y ? y + ', it' : 'It'}'s ${hour} in the morning. The chart will still be there.`]), 6);
  }
  sellNudges();
  // nothing has happened for twenty minutes: she dozes off
  if (pet.state === 'idle' && !panelOpen && !tourActive && T - pet.lastInteraction > SLEEP_AFTER && T - lastTradeAt > SLEEP_AFTER) setState('sleep');
}
const SLEEP_AFTER = 20 * 60;

// ---------------------------------------------------------------- settings panel
const panelEl = document.getElementById('panel');
let panelOpen = false;
// The settings live on tabs so the panel stays short enough to read on any screen. Each tab has
// a line icon: at this size an emoji is a coloured smudge, and four of them pulled from different
// glyph sets never look like one set of controls.
const PANEL_TABS = [
  ['her', 'Her', '<circle cx="12" cy="8.4" r="3.4"/><path d="M5.6 20.2a6.4 6.4 0 0 1 12.8 0"/>'],
  ['look', 'Look', '<path d="M9 3.6 6 5.2l1.3 3.2 1.7-.8V20h6V7.6l1.7.8L18 5.2 15 3.6a3 3 0 0 1-6 0Z"/>'],
  ['sign', 'Board', '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3"/><path d="M8 15.2l3.1-3.6 2.4 2.2L16.4 9"/>'],
  ['wallet', 'Wallet', '<path d="M4.4 8.6A2.6 2.6 0 0 1 7 6h9.6a3 3 0 0 1 3 3v6.6a3 3 0 0 1-3 3H7.4a3 3 0 0 1-3-3Z"/><path d="M15.4 12.6h4.2"/>'],
];
let panelTab = 'her';
// Her default figure: what a missing setting falls back to and what "Reset body" returns to.
// Mirrors the settings defaults in main.js — change both.
const FIG = { bust: 0.36, jiggle: 1, cleavage: 0.4, skirtLen: 0.3, hips: 0.36, waist: 0, thighs: 0.6, headSize: 1, bow: false };
const SOUND_EVENTS = [
  ['profit', 'Profit'], ['bigProfit', 'Big profit'], ['loss', 'Loss'], ['bigLoss', 'Big loss'], ['buy', 'Buy'], ['sell', 'Flat sell'],
  ['connect', 'Connected'], ['click', 'Clicked'], ['hover', 'Hovered'], ['grab', 'Picked up'], ['throw', 'Thrown'],
  ['land', 'Landing'], ['dizzy', 'Dizzy'], ['jump', 'Jump'], ['stretch', 'Stretch'], ['cheerUp', 'Cheer-up (after a loss)'],
];
const signed = (v) => { const n = Math.round(((v ?? 0.5) - 0.5) * 200); return (n > 0 ? '+' : '') + n + '%'; };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A slider's label carries its live value on the right; `readout` updates just that part while dragging.
const lab = (name, value) => `<label><span>${name}</span><b>${value}</b></label>`;
const readout = (input, value) => { const b = input.previousElementSibling && input.previousElementSibling.querySelector('b'); if (b) b.textContent = value; };
const pct = (v) => Math.round(v * 100) + '%';
function soundOptions(sel) {
  let h = '<option value=""' + (!sel ? ' selected' : '') + '>(silent)</option>';
  const files = cfg?.soundFiles || [];
  if (files.length) {
    h += '<optgroup label="files (sounds folder)">';
    for (const f of files) { const v = 'file:' + f.name; h += `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(f.name)}</option>`; }
    h += '</optgroup>';
  }
  for (const mood of MOODS) {
    h += `<optgroup label="${mood}">`;
    for (const [k, ph] of Object.entries(PHRASES)) if (ph.mood === mood) h += `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(ph.label)}</option>`;
    h += '</optgroup>';
  }
  return h;
}
function renderPanel() {
  if (!panelEl || !cfg) return;
  const c = cfg;
  const outfit = OUTFITS[c.outfit] ? c.outfit : 'uniform';
  const tab = PANEL_TABS.some((t) => t[0] === panelTab) ? panelTab : 'her';
  const pg = (id) => (id === tab ? '' : ' hidden');
  const tabIndex = Math.max(0, PANEL_TABS.findIndex((t) => t[0] === tab));
  panelEl.innerHTML = `
    <div class="hd"><span class="ava"></span>
      <div class="ttl"><span class="nm">Yui</span><span class="sub${relayStatus === 'ok' ? ' live' : ''}">${relayStatus === 'ok' ? 'connected' : 'settings'}</span></div>
      <button class="close" id="btnClose" title="Close (Esc)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>
    <div class="tabs" style="--i:${tabIndex}"><span class="ink"></span>${PANEL_TABS.map(([k, l, ic]) => `<button data-tab="${k}"${k === tab ? ' class="on"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ic}</svg><span>${l}</span></button>`).join('')}</div>

    <div class="pg" data-pg="her"${pg('her')}>
      <div class="row"><div class="f"><label>Size</label>
        <select id="fSize">${[['220', 'Small'], ['320', 'Medium'], ['460', 'Large'], ['640', 'Huge']].map(([v, l]) => `<option value="${v}"${Number(v) === c.sizePx ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="f"><label>Model</label><div class="btnrow"><button class="ghost" id="btnModel">Load VRM</button><button class="ghost icon fix" id="btnDefaultModel" title="Back to the bundled model">↺</button></div></div></div>
      <label class="sw"><input type="checkbox" id="fTop"${c.alwaysOnTop ? ' checked' : ''}>Always on top</label>
      <div class="sep"></div>
      <div class="row"><div class="f">${lab('Volume', pct(c.volume ?? 0.6))}<input type="range" id="fVol" min="0" max="1" step="0.02" value="${c.volume ?? 0.6}"></div>
        <div class="f">${lab('Pitch', (c.pitch ?? 1).toFixed(2) + '×')}<input type="range" id="fPitch" min="0.75" max="1.35" step="0.01" value="${c.pitch ?? 1}"></div></div>
      <div class="row"><label class="sw mini" style="flex:1"><input type="checkbox" id="fMute"${c.muted ? ' checked' : ''}>Mute</label>
        <button class="ghost fix" id="btnVoiceTest">Test voice</button></div>
      <div class="sep"></div>
      <div class="f"><label><span>Your name</span><b>what she calls you</b></label><input type="text" id="fUserName" value="${esc(c.userName || '')}" placeholder="Alex" maxlength="24" spellcheck="false"></div>
      <div class="sep"></div>
      <div class="f"><label><span>Quiet</span><b>${dndOn() ? 'do not disturb until ' + new Date(Number(c.dndUntil)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'she reacts to everything'}</b></label>
        <select id="fDnd"><option value="0">${dndOn() ? 'Stop do not disturb' : 'Do not disturb…'}</option><option value="30">for 30 minutes</option><option value="60">for 1 hour</option><option value="120">for 2 hours</option><option value="tomorrow">until tomorrow 08:00</option></select></div>
      <div class="row"><label class="sw mini" style="flex:1"><input type="checkbox" id="fQuietBubbles"${c.quietBubbles ? ' checked' : ''}>No speech</label>
        <label class="sw mini" style="flex:1"><input type="checkbox" id="fQuietReactions"${c.quietReactions ? ' checked' : ''}>No reactions</label></div>
      <div class="row"><label class="sw mini" style="flex:1"><input type="checkbox" id="fQuietBoard"${c.quietBoard ? ' checked' : ''}>No board</label>
        <label class="sw mini" style="flex:1"><input type="checkbox" id="fQuietSounds"${c.quietSounds ? ' checked' : ''}>No sounds</label></div>
      ${Array.isArray(c.displays) && c.displays.length > 1 ? `<div class="sep"></div><div class="f"><label>Screen</label><select id="fDisplay">${c.displays.map((d) => `<option value="${d.id}"${(c.display == null ? d.primary : String(c.display) === String(d.id)) ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select></div>` : ''}
      <div class="sep"></div>
      <div class="row"><button class="ghost" id="btnTour">Replay tutorial</button><button class="ghost danger" id="btnReset">Reset everything</button></div>
    </div>

    <div class="pg" data-pg="look"${pg('look')}>
      <div class="row"><div class="f">${lab('Bust', pct(c.bust ?? FIG.bust))}<input type="range" id="fBust" min="0" max="1" step="0.02" value="${c.bust ?? FIG.bust}"></div>
        <div class="f">${lab('Bounce', pct(c.jiggle ?? FIG.jiggle))}<input type="range" id="fJiggle" min="0" max="1" step="0.02" value="${c.jiggle ?? FIG.jiggle}"></div></div>
      <div class="row"><div class="f">${lab('Cleavage', pct(c.cleavage ?? FIG.cleavage))}<input type="range" id="fCleavage" min="0" max="1" step="0.05" value="${c.cleavage ?? FIG.cleavage}"></div>
        <div class="f">${lab('Skirt length', pct(c.skirtLen ?? FIG.skirtLen))}<input type="range" id="fSkirtLen" min="0.3" max="1" step="0.02" value="${c.skirtLen ?? FIG.skirtLen}"></div></div>
      <div class="row"><div class="f">${lab('Hips', signed(c.hips ?? FIG.hips))}<input type="range" id="fHips" min="0" max="1" step="0.02" value="${c.hips ?? FIG.hips}"></div>
        <div class="f">${lab('Waist', signed(c.waist ?? FIG.waist))}<input type="range" id="fWaist" min="0" max="1" step="0.02" value="${c.waist ?? FIG.waist}"></div></div>
      <div class="row"><div class="f">${lab('Thighs', signed(c.thighs ?? FIG.thighs))}<input type="range" id="fThighs" min="0" max="1" step="0.02" value="${c.thighs ?? FIG.thighs}"></div>
        <div class="f">${lab('Head', signed(c.headSize ?? FIG.headSize))}<input type="range" id="fHeadSize" min="0" max="1" step="0.02" value="${c.headSize ?? FIG.headSize}"></div></div>
      <div class="row"><div class="f fix"><label>&nbsp;</label><button class="ghost" id="btnResetBody">Reset body</button></div><div class="f"></div></div>
      <div class="row"><div class="f"><label>Outfit</label><select id="fOutfit">${Object.entries(OUTFITS).map(([k, o]) => `<option value="${k}"${k === outfit ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div class="f"><label>Top</label><select id="fTopStyle">${Object.entries(TOP_STYLES).map(([k, l]) => `<option value="${k}"${k === (TOP_STYLES[c.topStyle] ? c.topStyle : 'full') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>
      <div class="row"><div class="f"><label>Bottom</label><select id="fBottomStyle">${Object.entries(BOTTOM_STYLES).map(([k, l]) => `<option value="${k}"${k === (BOTTOM_STYLES[c.bottomStyle] ? c.bottomStyle : 'skirt') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="f"><label>&nbsp;</label><label class="sw mini"><input type="checkbox" id="fBow"${(c.bow ?? FIG.bow) ? ' checked' : ''}>Ribbon</label></div></div>
      <div class="sep"></div>
      <div class="row"><div class="f"><label>Hair</label><input type="color" id="fHairColor" value="${esc(c.hairColor || '#2b2340')}"></div>
        <div class="f"><label>Eyes</label><input type="color" id="fEyeColor" value="${esc(c.eyeColor || '#8a6a3a')}"></div>
        <div class="f fix"><label>&nbsp;</label><button class="ghost" id="btnResetColors">Reset</button></div></div>
      ${outfit === 'custom' ? `<div class="row"><div class="f"><label>Top</label><input type="color" id="fCustomVest" value="${esc(c.customVest || '#1a1a20')}"></div>
        <div class="f"><label>Skirt</label><input type="color" id="fCustomSkirt" value="${esc(c.customSkirt || '#1a1a20')}"></div>
        <div class="f"><label>Accent</label><input type="color" id="fCustomBow" value="${esc(c.customBow || '#f2c73f')}"></div></div>` : ''}
    </div>

    <div class="pg" data-pg="sign"${pg('sign')}>
      <label class="sw"><input type="checkbox" id="fSign"${c.sign !== false ? ' checked' : ''}>Show the PnL board</label>
      <div class="sep"></div>
      <div class="row"><div class="f"><label>Hold</label><select id="fSignHold">${[['auto', 'Either hand'], ['one', 'One hand'], ['two', 'Both hands']].map(([v, l]) => `<option value="${v}"${v === (c.signHold || 'auto') ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="f"><label>Board style</label><select id="fSignStyle">${SIGN_STYLES.map((st, i) => `<option value="${i}"${i === SIGN_STYLES.indexOf(signStyle()) ? ' selected' : ''}>${esc(st.label)}</option>`).join('')}</select></div></div>
      <div class="f">${lab('Board size', pct(c.signSize ?? 1))}<input type="range" id="fSignSize" min="0.5" max="1.8" step="0.05" value="${c.signSize ?? 1}"></div>
      <div class="hint">Held in both hands the board is sized to her grip, so this only widens the overhang.</div>
      <div class="row"><div class="f half">${lab('SOL price $', liveSolUsd > 0 ? 'live ' + liveSolUsd.toFixed(2) : 'fallback')}<input type="text" id="fSolPrice" value="${esc(String(c.solPrice ?? 101.95))}" spellcheck="false"></div><div class="f"></div></div>
      <div class="hint">The relay sends the live SOL price; this is only used until it has.</div>
      <div class="sep"></div>
      <div class="row"><div class="f"><label>Open coins in</label><select id="fOpenWith">${[['axiom', 'Axiom'], ['pump', 'pump.fun'], ['dexscreener', 'DexScreener']].map(([v, l]) => `<option value="${v}"${v === (c.openWith || 'axiom') ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="f"><label>&nbsp;</label><label class="sw mini"><input type="checkbox" id="fGuard"${c.guard !== false ? ' checked' : ''}>"Are you sure?" look</label></div></div>
      <div class="hint">Hover the board for its badges: close, open the coin, copy the address, flip to every open bag. The look is for buying back a coin you just sold at a loss.</div>
      <div class="row"><div class="f">${lab('Nudge when up', (Number(c.nudgePct) > 0 ? Number(c.nudgePct) : 50) + '%')}<input type="range" id="fNudgePct" min="10" max="300" step="10" value="${Number(c.nudgePct) > 0 ? Number(c.nudgePct) : 50}"></div>
        <div class="f">${lab('and held for', (Number(c.nudgeMin) > 0 ? Number(c.nudgeMin) : 30) + ' min')}<input type="range" id="fNudgeMin" min="5" max="240" step="5" value="${Number(c.nudgeMin) > 0 ? Number(c.nudgeMin) : 30}"></div></div>
      <div class="hint">"You've held $X for 42 min and it's +80% — just saying~"</div>
      <div class="sep"></div>
      <div class="f"><label>Try it out</label>
        <div class="btnrow"><button class="ghost" id="btnTestSign">${demoPos ? 'Stop test' : 'Test position'}</button><button class="ghost" id="btnScorecard">Today's card</button></div></div>
      <div class="f"><label>Try a reaction</label>
        <div class="btnrow"><button class="ghost" id="tProfit">Profit</button><button class="ghost" id="tLoss">Loss</button><button class="ghost" id="tBuy">Buy</button></div></div>
    </div>

    <div class="pg" data-pg="wallet"${pg('wallet')}>
      <div class="f"><label>Wallet address</label>
        <input type="text" id="fWallets" value="${esc(c.wallets)}" placeholder="paste the address you trade from" spellcheck="false">
        <div class="hint">Comma separated for several — add every wallet you buy from.</div></div>
      <div class="row"><button id="btnConnect" class="fix">${relay ? 'Disconnect' : 'Connect'}</button>
        <label class="sw mini" style="flex:1"><input type="checkbox" id="fAuto"${c.autoConnect ? ' checked' : ''}>Connect on start</label></div>
      <div class="status" id="relayStatus"></div>
      <div class="status" id="relayTrades" hidden></div>
      <div class="sep"></div>
      <div class="f"><label>Relay URL</label><input type="text" id="fRelay" value="${esc(c.relayUrl)}" spellcheck="false"></div>
      <div class="f"><label>Relay token</label><input type="password" id="fToken" value="${esc(c.relayToken)}"></div>
      <div class="f"><label>Custom sounds &middot; ${(c.soundFiles || []).length} file${(c.soundFiles || []).length === 1 ? '' : 's'}</label>
        <div class="btnrow"><button class="ghost" id="btnSoundsFolder">Open sounds folder</button></div></div>
    </div>

    <div class="foot"><button class="ghost" id="btnQuit">Quit</button>
      <span class="build" title="When this build was compiled. If it is older than a change you expect, relaunch her.">build ${esc(c.build || '?')}</span></div>`;
  const $ = (id) => panelEl.querySelector('#' + id);
  $('btnClose').onclick = closePanel;
  const tabs = panelEl.querySelector('.tabs');
  for (const b of panelEl.querySelectorAll('.tabs button')) {
    b.onclick = () => {
      panelTab = b.dataset.tab;
      tabs.style.setProperty('--i', String(Math.max(0, PANEL_TABS.findIndex((t) => t[0] === panelTab))));
      for (const x of panelEl.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
      for (const p of panelEl.querySelectorAll('.pg')) p.hidden = p.dataset.pg !== panelTab;
      positionPanel();
    };
  }
  // the track is lit up to the thumb: the fill is a CSS variable each slider keeps current itself
  const fill = (r) => r.style.setProperty('--p', ((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min)) * 100).toFixed(1) + '%');
  for (const r of panelEl.querySelectorAll('input[type=range]')) { fill(r); r.addEventListener('input', () => fill(r)); }
  $('fSize').onchange = (e) => saveCfg({ sizePx: Number(e.target.value) });
  $('btnModel').onclick = () => bridge.pickModel();
  $('btnDefaultModel').onclick = () => bridge.defaultModel();
  $('fTop').onchange = (e) => saveCfg({ alwaysOnTop: e.target.checked });
  $('fBust').oninput = (e) => { saveCfg({ bust: Number(e.target.value) }); applyFigure(); readout(e.target, pct(cfg.bust)); };
  $('fJiggle').oninput = (e) => { saveCfg({ jiggle: Number(e.target.value) }); applyFigure(); readout(e.target, pct(cfg.jiggle)); };
  $('fOutfit').onchange = (e) => { saveCfg({ outfit: e.target.value }); applyFigureTextures(); renderPanel(); positionPanel(); };
  $('fCleavage').onchange = (e) => { saveCfg({ cleavage: Number(e.target.value) }); applyFigureTextures(); };
  for (const [id, key, label] of [['fHips', 'hips', 'Hips'], ['fWaist', 'waist', 'Waist'],
    ['fThighs', 'thighs', 'Thighs'], ['fHeadSize', 'headSize', 'Head']]) {
    const el = $(id);
    if (el) el.oninput = (e) => {
      const v = Number(e.target.value);
      saveCfg({ [key]: v }); applyFigure();
      readout(e.target, signed(v));
    };
  }
  $('fCleavage').oninput = (e) => { readout(e.target, pct(Number(e.target.value))); };
  $('fTopStyle').onchange = (e) => { saveCfg({ topStyle: e.target.value }); applyFigure(); applyFigureTextures(); };
  $('fBottomStyle').onchange = (e) => { saveCfg({ bottomStyle: e.target.value }); applyFigure(); applyFigureTextures(); };
  $('fSkirtLen').oninput = (e) => { saveCfg({ skirtLen: Number(e.target.value) }); applyFigure(); readout(e.target, pct(cfg.skirtLen)); };
  $('fBow').onchange = (e) => { saveCfg({ bow: e.target.checked }); applyFigure(); };
  $('fHairColor').onchange = (e) => { saveCfg({ hairColor: e.target.value }); applyFigureTextures(); };
  $('fEyeColor').onchange = (e) => { saveCfg({ eyeColor: e.target.value }); applyFigureTextures(); };
  $('btnResetColors').onclick = () => { saveCfg({ hairColor: '', eyeColor: '' }); applyFigureTextures(); renderPanel(); positionPanel(); };
  const resetBody = $('btnResetBody');
  if (resetBody) resetBody.onclick = () => {
    saveCfg({ hips: FIG.hips, waist: FIG.waist, thighs: FIG.thighs, headSize: FIG.headSize });
    applyFigure(); renderPanel(); positionPanel();
  };
  for (const [id, key] of [['fCustomVest', 'customVest'], ['fCustomSkirt', 'customSkirt'], ['fCustomBow', 'customBow']]) {
    const el = $(id); if (el) el.onchange = (e) => { saveCfg({ [key]: e.target.value }); applyFigureTextures(); };
  }
  $('fVol').oninput = (e) => { saveCfg({ volume: Number(e.target.value) }); readout(e.target, pct(cfg.volume)); };
  $('fVol').onchange = () => playAssigned(cfg.sounds.sell || 'un');
  $('fPitch').oninput = (e) => { saveCfg({ pitch: Number(e.target.value) }); readout(e.target, cfg.pitch.toFixed(2) + '×'); };
  $('fPitch').onchange = () => playAssigned(cfg.sounds.click || 'hai');
  $('fMute').onchange = (e) => saveCfg({ muted: e.target.checked });
  $('fUserName').onchange = (e) => saveCfg({ userName: e.target.value.trim().slice(0, 24) });
  $('fDnd').onchange = (e) => {
    const v = e.target.value; let until = 0;
    if (v === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); until = d.getTime(); }
    else if (Number(v) > 0) until = Date.now() + Number(v) * 60000;
    saveCfg({ dndUntil: until }); renderPanel(); positionPanel();
    if (until) say('Okay, I\'ll be quiet~', 2.5);
  };
  for (const [id, key] of [['fQuietBubbles', 'quietBubbles'], ['fQuietReactions', 'quietReactions'], ['fQuietBoard', 'quietBoard'], ['fQuietSounds', 'quietSounds']]) {
    const el = $(id); if (el) el.onchange = (e) => { saveCfg({ [key]: e.target.checked }); if (key === 'quietBoard' && sign) sign.text = ''; };
  }
  const disp = $('fDisplay'); if (disp) disp.onchange = (e) => bridge.setDisplay(Number(e.target.value));
  $('btnTour').onclick = () => { closePanel(); startTour(); };
  $('btnReset').onclick = () => {
    if (!confirm('Reset everything? Her look, your name, the wallet and every other setting go back to how she came. The tutorial runs again.')) return;
    closePanel(); bridge.resetSettings();
  };
  $('btnVoiceTest').onclick = () => { playAssigned(pick([cfg.sounds.click, cfg.sounds.profit, cfg.sounds.connect, cfg.sounds.hover].filter(Boolean)) || 'hai'); say(line(LINES.greet, herName())); };
  const reconnectIfLive = () => { if (relay || relayStatus === 'connecting') connectRelay(); };
  $('fWallets').onchange = (e) => { saveCfg({ wallets: e.target.value.trim() }); reconnectIfLive(); };
  $('fRelay').onchange = (e) => { saveCfg({ relayUrl: e.target.value.trim() }); reconnectIfLive(); };
  $('fToken').onchange = (e) => { saveCfg({ relayToken: e.target.value.trim() }); reconnectIfLive(); };
  $('fAuto').onchange = (e) => saveCfg({ autoConnect: e.target.checked });
  $('btnConnect').onclick = () => { if (relay) disconnectRelay(); else connectRelay(); };
  $('fSign').onchange = (e) => saveCfg({ sign: e.target.checked });
  $('fSignHold').onchange = (e) => { saveCfg({ signHold: e.target.value }); if (sign && sign.phase === 'held') { sign.two = signTwoHanded(); sign.text = ''; } };
  $('fSignStyle').onchange = (e) => { saveCfg({ signStyle: Number(e.target.value) }); if (sign) sign.text = ''; };
  $('fSolPrice').onchange = (e) => { const v = Number(e.target.value); if (v > 0) saveCfg({ solPrice: v }); if (sign) sign.text = ''; };
  $('btnTestSign').onclick = () => { if (cfg.sign === false) saveCfg({ sign: true }); toggleDemoSign(); renderPanel(); positionPanel(); };
  $('btnScorecard').onclick = () => { demoPos = null; showScorecard(dayStats(), 'TODAY'); };
  $('fOpenWith').onchange = (e) => saveCfg({ openWith: e.target.value });
  $('fGuard').onchange = (e) => saveCfg({ guard: e.target.checked });
  $('fNudgePct').oninput = (e) => { saveCfg({ nudgePct: Number(e.target.value) }); readout(e.target, e.target.value + '%'); };
  $('fNudgeMin').oninput = (e) => { saveCfg({ nudgeMin: Number(e.target.value) }); readout(e.target, e.target.value + ' min'); };
  $('fSignSize').oninput = (e) => { saveCfg({ signSize: Number(e.target.value) }); readout(e.target, pct(cfg.signSize)); };
  $('tProfit').onclick = () => reactToTrade({ side: 'sell', symbol: 'PEPE', quote: 'SOL', amount: 1.42, pnl: 0.61, pnlPct: 75 });
  $('tLoss').onclick = () => reactToTrade({ side: 'sell', symbol: 'WOJAK', quote: 'SOL', amount: 0.31, pnl: -0.24, pnlPct: -44 });
  $('tBuy').onclick = () => reactToTrade({ side: 'buy', symbol: 'MOON', quote: 'SOL', amount: 0.5 });
  $('btnSoundsFolder').onclick = () => bridge.openSoundsFolder();
  $('btnQuit').onclick = () => bridge.quit();
  refreshRelayStatus();
}
// The panel sits beside her and follows her, so it never ends up stranded across the screen.
// Its size is only measured when the contents change: measuring every frame forces a reflow.
let panelW = 336, panelH = 460, panelLeft = -1, panelTop = -1;
let lastTradeTick = 0;
function positionPanel(measure = true) {
  if (!panelEl || panelEl.hidden) return;
  if (measure) { panelW = panelEl.offsetWidth || panelW; panelH = panelEl.offsetHeight || panelH; }
  const sp = toScreen(pet.x, pet.y);
  const gap = sizePx * 0.30 + 12;
  let left = sp.x + gap;
  if (left + panelW > W - 12) left = sp.x - gap - panelW;   // no room on her right: put it on her left
  left = clamp(left, 12, W - panelW - 12);
  const top = clamp(sp.y - sizePx * 0.5 - panelH / 2, 12, H - panelH - 12); // centred on her body
  if (Math.abs(left - panelLeft) > 0.5) { panelEl.style.left = left.toFixed(1) + 'px'; panelLeft = left; }
  if (Math.abs(top - panelTop) > 0.5) { panelEl.style.top = top.toFixed(1) + 'px'; panelTop = top; }
}
function openPanel(tab) {
  if (!panelEl || !cfg) return;
  if (!tab) tourFlag('panel');   // opened by a click on her, not by the tour itself
  if (tab) panelTab = tab;
  panelOpen = true; panelEl.hidden = false;
  if (pet.state === 'walk') setState('idle');   // stand still while her settings are open
  panelLeft = panelTop = -1;                    // place it fresh rather than leaving it where it was
  renderPanel(); positionPanel();
}
function closePanel() {
  if (!panelEl) return;
  panelOpen = false; panelEl.hidden = true;
}
function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }

// she must not be holding anything open while she is being thrown around
function closeHer() { if (panelOpen) closePanel(); }

// ---------------------------------------------------------------- the first-run tour
// She walks a new user through herself: a card in the panel's glass beside her, with a tail toward
// her and her own voice in the bubble. Steps that ask for something wait for it (a click, a throw,
// a wallet); the rest step on a button. It runs once, on the first boot, and again from the Her
// tab or after a reset. Nothing here blocks her: she still reacts, walks and talks throughout.
const tourEl = document.getElementById('tour');
const TOUR = [
  { key: 'name', eyebrow: 'Welcome', title: "Hi! I'm Yui, your Trading Companion", body: "I'll live down here on your taskbar, watch your wallet and react to every trade — cheering, sulking, keeping score. First: what should I call you?",
    input: true, cta: 'Nice to meet you', say: () => "I'm Yui, your Trading Companion~ What should I call you?" },
  { key: 'click', eyebrow: 'Step 1 of 7', title: 'Click me once', body: 'That opens my settings. Click me again to put them away, or press Escape.',
    wait: 'waiting for a click', flag: 'panel', skip: 'Skip', say: (y) => `Click me${y ? ', ' + y : ''}~` },
  { key: 'throw', eyebrow: 'Step 2 of 7', title: 'Pick me up', body: 'Grab me anywhere and drag. Let go while moving and I fly. I land on my feet. Mostly.',
    wait: 'waiting for a throw', flag: 'throw', skip: 'Skip', say: (y) => `Throw me${y ? ', ' + y : ''}! I can take it~` },
  { key: 'look', eyebrow: 'Step 3 of 7', title: 'Dress me up', body: 'The Look tab: outfit, hair, the shape of me. Everything applies live and is remembered. Take your time — press the button when you are happy.',
    highlight: 'look', unlock: 'look', cta: 'Done dressing', say: () => 'Make me cute~' },
  { key: 'wallet', eyebrow: 'Step 4 of 7', title: 'Connect your wallet', body: "In the Wallet tab: paste the public address you buy from, then press Connect. When it says Live, I can see your trades. I only read the address — I never ask you to sign anything.",
    highlight: 'wallet', wait: 'waiting for Live', flag: 'wallet', skip: 'Later', say: () => 'Whose bags am I watching?' },
  { key: 'testbuy', eyebrow: 'Step 5 of 7', title: 'Make a small test buy', body: "Any coin, any size — I react the moment it lands, and my board shows the position. Sell it afterwards to see the other side.",
    wait: 'waiting for your trade', flag: 'trade', skip: 'Skip', needsRelay: true, say: (y) => `Go on${y ? ' ' + y : ''}, I'm watching~` },
  { key: 'reactions', eyebrow: 'Step 6 of 7', title: 'What I do', body: "Try each one. These are pretend — nothing is sent anywhere. I jump when you win, bruise when you lose, and the marks heal over a few minutes.",
    demo: true, cta: 'Next', say: () => 'Press one!' },
  { key: 'done', eyebrow: 'That is everything', title: (y) => `Have fun${y ? ', ' + y : ''}!`, body: "I'll be down here on your taskbar. The Her tab replays this or resets me if you ever want a fresh start.",
    cta: "Let's go", say: (y) => `Good luck out there${y ? ', ' + y : ''}~` },
];
let tourActive = false, tourStep = -1, tourStepAt = 0;
const tourFlags = { panel: false, throw: false, look: false, wallet: false, trade: false };
function tourFlag(k) { if (tourActive && k in tourFlags) tourFlags[k] = true; }
function startTour() {
  if (!tourEl || !model) return;
  for (const k in tourFlags) tourFlags[k] = false;
  tourActive = true; tourStep = -1;
  if (pet.state === 'walk') setState('idle');
  tourGo(0);
}
function endTour() {
  tourActive = false; tourStep = -1;
  tourEl.hidden = true; tourEl.innerHTML = '';
  tourHighlight(null);
  saveCfg({ tourDone: true });
}
function tourHighlight(tab) {
  if (!panelEl) return;
  for (const b of panelEl.querySelectorAll('.tabs button')) b.classList.toggle('tour-hi', !!tab && b.dataset.tab === tab);
}
function tourGo(i) {
  if (i >= TOUR.length) { endTour(); return; }
  if (TOUR[i].needsRelay && relayStatus !== 'ok') { tourGo(i + 1); return; }   // no wallet connected: nothing to wait for
  tourStep = i; tourStepAt = T;
  const st = TOUR[i], y = who();
  const title = typeof st.title === 'function' ? st.title(y) : st.title;
  tourEl.className = '';
  tourEl.innerHTML = `<span class="tail"></span><div class="eyebrow">${esc(st.eyebrow)}</div><h3>${esc(title)}</h3><p>${esc(st.body)}</p>`
    + (st.input ? `<input type="text" id="tourName" placeholder="Alex" maxlength="24" spellcheck="false" value="${esc(y)}">` : '')
    + (st.demo ? `<div class="demo"><button class="ghost" data-demo="profit">Profit</button><button class="ghost" data-demo="loss">Loss</button><button class="ghost" data-demo="buy">Buy</button></div>` : '')
    + `<div class="actions">`
    + (st.cta ? `<button id="tourNext"${st.unlock && !tourFlags[st.unlock] ? ' disabled title="Change something first"' : ''}>${esc(st.cta)}</button>` : `<span class="wait">${esc(st.wait)}</span>`)
    + (st.skip ? `<button class="ghost" id="tourSkip">${esc(st.skip)}</button>` : '')
    + `<span class="dots">${TOUR.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'on' : ''}"></i>`).join('')}</span></div>`;
  tourEl.hidden = false;
  positionTour();
  const next = tourEl.querySelector('#tourNext'), skip = tourEl.querySelector('#tourSkip'), input = tourEl.querySelector('#tourName');
  const advance = () => {
    if (input) saveCfg({ userName: input.value.trim().slice(0, 24) });
    tourGo(i + 1);
  };
  if (next) next.onclick = advance;
  if (skip) skip.onclick = () => tourGo(i + 1);
  for (const b of tourEl.querySelectorAll('[data-demo]')) b.onclick = () => tourDemo(b.dataset.demo);
  if (!st.highlight && panelOpen) closePanel();   // the test buy and the demos want her in the clear
  if (input) { input.onkeydown = (e) => { if (e.key === 'Enter') advance(); }; setTimeout(() => input.focus(), 50); }
  // she points at the tab the step is about, with it open in front of the user
  if (st.highlight) { openPanel(st.highlight); }
  if (st.flag === 'wallet' && relayStatus === 'ok') { tourFlags.wallet = true; tourStepAt = T + 1.2; }   // already connected: show the step, then move on
  tourHighlight(st.highlight || null);
  if (st.say) say(st.say(y), 5);
  if (st.key === 'done') setState('wave');
}
// the pretend trades behind the demo buttons: they go through reactToTrade only, never the book
function tourDemo(kind) {
  if (kind === 'profit') reactToTrade({ side: 'sell', symbol: 'PEPE', quote: 'SOL', amount: 1.42, pnl: 0.61, pnlPct: 75 });
  else if (kind === 'loss') reactToTrade({ side: 'sell', symbol: 'WOJAK', quote: 'SOL', amount: 0.31, pnl: -0.24, pnlPct: -44 });
  else reactToTrade({ side: 'buy', symbol: 'MOON', quote: 'SOL', amount: 0.5 });
}
// steps that wait for the user move on the moment it happens
function tourTick() {
  if (!tourActive || tourStep < 0) return;
  const st = TOUR[tourStep];
  if (st.flag && tourFlags[st.flag] && T - tourStepAt > 0.4) {
    if (st.flag === 'panel') sound('click');
    tourGo(tourStep + 1);
  }
  // a step that unlocks its button once the user has done the thing: they continue when ready
  if (st.unlock && tourFlags[st.unlock]) { const b = tourEl.querySelector('#tourNext'); if (b && b.disabled) { b.disabled = false; b.title = ''; say('Ehehe, cute! Keep going, or press the button~', 4); } }
}
// beside her, on the side the panel is not using, following her as she moves
let tourLeft = -1, tourTop = -1;
function positionTour() {
  if (!tourEl || tourEl.hidden || !model) return;
  const sp = toScreen(pet.x, pet.y);
  const w = tourEl.offsetWidth || 292, h = tourEl.offsetHeight || 200;
  const gap = sizePx * 0.30 + 12;
  let top = clamp(sp.y - sizePx * 0.78 - 30, 12, H - h - 12);   // level with her head, where the tail points
  let left, side;
  const fits = (l) => l >= 12 && l + w <= W - 12;
  if (panelOpen) {
    // The panel is beside her. The card takes her other side; when she is against the screen edge
    // and there is no room there, it goes beyond the panel instead — never on top of it.
    const panelOnRight = panelLeft >= sp.x;
    left = panelOnRight ? sp.x - gap - w : sp.x + gap; side = panelOnRight ? 'left' : 'right';
    if (!fits(left)) { left = panelOnRight ? panelLeft + panelW + 10 : panelLeft - w - 10; side = 'none'; top = clamp(panelTop, 12, H - h - 12); }
    if (!fits(left)) { left = clamp(panelLeft + (panelW - w) / 2, 12, W - w - 12); top = panelTop - h - 10 >= 12 ? panelTop - h - 10 : clamp(panelTop + panelH + 10, 12, H - h - 12); side = 'none'; }
  } else {
    const room = sp.x + gap + panelW <= W - 12;   // where the panel will go when it opens: keep that side free
    left = room ? sp.x - gap - w : sp.x + gap; side = room ? 'left' : 'right';
    if (!fits(left)) { left = room ? sp.x + gap : sp.x - gap - w; side = room ? 'right' : 'left'; }
  }
  left = clamp(left, 12, W - w - 12);
  tourEl.classList.toggle('left', side === 'left'); tourEl.classList.toggle('right', side === 'right');
  if (Math.abs(left - tourLeft) > 0.5) { tourEl.style.left = left.toFixed(1) + 'px'; tourLeft = left; }
  if (Math.abs(top - tourTop) > 0.5) { tourEl.style.top = top.toFixed(1) + 'px'; tourTop = top; }
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHer(); });

// ---------------------------------------------------------------- pet state
const pet = {
  x: 0, y: 0, vx: 0, vy: 0,        // world position / velocity (feet)
  theta: 0, omega: 0,              // body tilt (rad) and angular velocity
  yaw: 0, yawTarget: 0,            // facing (rotation about Y)
  facing: 1,
  onGround: true,
  state: 'idle', t: 0,             // current state and time spent in it
  bob: 0, crouch: 0,               // visual vertical offsets
  squash: new Spring(1, 320, 18),
  grab: null,                      // { gx, gy, bone, pivot, pivotVel, pivotAcc, shake }
  walkTarget: 0, walkPhase: 0,
  micro: null,                     // idle micro-action { name, t, dur }
  nextActionAt: 5,
  lastInteraction: 0,
  hoverTime: 0,
  dizzy: 0,
  happy: 0,
  glow: 0, hurt: 0, wounds: [],     // trade after-effects: golden glow / bruises (see updateFx)
  mood: 0,                         // -1 worried .. +1 bouncy; fades over an hour
  pokeAt: -99, flinchAt: -99, sleepSaidAt: 0,
  jumpFlag: false,
  sitUntil: 0,
};
const G = 9.0; // gravity in world units/s²

const cursor = { sx: -9999, sy: -9999, wx: 0, wy: 0, vx: 0, vy: 0, lastT: 0, hit: null, down: false, seen: false };
let T = 0; // global time

function setState(s) {
  if (pet.state === s) return;
  const was = pet.state;
  pet.state = s; pet.t = 0;
  // The website's tour waits for the visitor to actually pick her up and throw her. Sampling her
  // state on a timer misses a quick flick, so it is told about every change instead. Nothing sets
  // this on the desktop.
  if (window.__petOnState) { try { window.__petOnState(s, was); } catch (e) { bridge.log('state hook: ' + e.message); } }
  if (s === 'walk') {
    // pick a destination at least 1.5 units away
    let tx = pet.x;
    for (let i = 0; i < 8 && Math.abs(tx - pet.x) < 1.5; i++) tx = rand(minX + 0.3, maxX - 0.3);
    pet.walkTarget = clamp(tx, minX, maxX);
    pet.facing = Math.sign(pet.walkTarget - pet.x) || 1;
  }
  if (s === 'idle') { pet.micro = null; pet.nextActionAt = T + rand(4, 10) * (moodUp() ? 0.6 : moodDown() ? 1.8 : 1); }
  if (s === 'sleep') { pet.micro = null; pet.sleepSaidAt = T; say('…zzz', 3); }
  if (s === 'wake') { sound('grab', { cooldown: 2, volume: 0.6 }); }
  if (s === 'gasp' || s === 'wince' || s === 'guard') pet.micro = null;
  if (s === 'comfort') { pet.comfortSide = Math.random() < 0.5 ? -1 : 1; pet.cheeredUp = false; }
  if (s === 'sit') { pet.sitUntil = T + rand(30, 90); }
  if (s === 'dizzy') sound('dizzy');
  if (s !== 'grabbed') pet.grab = null;
}

// ---------------------------------------------------------------- input
function updateCursor(sx, sy) {
  // while the self-test steps the simulation, cursor velocity must come from simulated time too (deterministic under load)
  const now = paused ? T : performance.now() / 1000;
  const dt = Math.max(1e-3, now - cursor.lastT);
  if (cursor.seen && dt < 0.25) {
    const a = 1 - Math.exp(-dt * 25);
    cursor.vx = lerp(cursor.vx, (sx - cursor.sx) / dt, a);
    cursor.vy = lerp(cursor.vy, (sy - cursor.sy) / dt, a);
  } else { cursor.vx = 0; cursor.vy = 0; }
  cursor.sx = sx; cursor.sy = sy; cursor.lastT = now; cursor.seen = true;
  const w = toWorld(sx, sy); cursor.wx = w.x; cursor.wy = w.y;
}
bridge.onCursor((p) => updateCursor(p.x, p.y));
const realInput = (e) => !(window.__petSyntheticOnly && e.isTrusted); // the self-test ignores the physical mouse
window.addEventListener('mousemove', (e) => { if (realInput(e)) updateCursor(e.clientX, e.clientY); });

let lastClickAt = -1, downAt = 0, downX = 0, downY = 0;
let downPanelOpen = false; // whether her settings were up when the press began
window.addEventListener('mousedown', (e) => {
  if (!realInput(e)) return;
  if (panelOpen && e.target instanceof Node && panelEl.contains(e.target)) return; // let the panel handle its own clicks
  if (tourActive && e.target instanceof Node && tourEl.contains(e.target)) return;
  updateCursor(e.clientX, e.clientY);
  if (!model) return;
  const sb = signHitTest().badge;
  if (e.button === 0 && sb) { e.preventDefault(); signBadgeAction(sb); return; }   // a badge on her board
  cursor.hit = hitTest();
  if (!cursor.hit) { closeHer(); return; }
  e.preventDefault();
  pet.lastInteraction = T;
  if (e.button === 2) { bridge.contextMenu(); return; }
  if (e.button !== 0) return;
  cursor.down = true; downAt = T; downX = e.clientX; downY = e.clientY;
  downPanelOpen = panelOpen;
  closeHer();                       // whatever is open would be left stranded as she moves
  beginGrab(cursor.hit);
});
window.addEventListener('mouseup', (e) => {
  if (!realInput(e)) return;
  if (e.button !== 0 || !cursor.down) return;
  cursor.down = false;
  updateCursor(e.clientX, e.clientY);
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (T - downAt < 0.3 && moved < 8) {
    // a click, not a drag: undo the grab and react instead
    const g = pet.grab;
    pet.grab = null;
    if (g && g.wasOnGround) { pet.onGround = true; pet.y = groundY; }
    if (T - lastClickAt < 0.4) { lastClickAt = -1; if (panelOpen) closePanel(); if (pet.onGround) doJump(); else setState('falling'); }
    else {
      lastClickAt = T;
      setState(pet.onGround ? 'wave' : 'falling');
      // The press already put her settings away, so a click with them open is "close" and must
      // not toggle them straight back; one with them closed opens them.
      if (!downPanelOpen && pet.onGround) {
        openPanel(); sound('click');
        const y = who();
        if (cursor.hit === 'head') pet.pokeAt = T;   // a tap on the head is a poke, whatever else it does
        say(moodUp() ? pick([`We're on a roll${y ? ', ' + y : ''}~`, `Ehehe, today is going well${y ? ', ' + y : ''}!`]) : moodDown() ? pick([`…hey${y ? ' ' + y : ''}. Rough one, huh?`, `I'm still here${y ? ', ' + y : ''}.`]) : line(LINES.greet, herName()));
      }
    }
    return;
  }
  releaseGrab();
});
// Without these an exception just stops her mid-frame with nothing in the log to explain it.
window.addEventListener('error', (e) => bridge.log('renderer error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => bridge.log('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = e.target;
  if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'password')) { t.focus(); bridge.editMenu(); }   // cut / copy / paste in her fields
});
window.addEventListener('dblclick', (e) => e.preventDefault());

bridge.onCommand((c) => {
  pet.lastInteraction = T;
  if (c === 'settings') { openPanel(); return; }
  if (c === 'wave') setState('wave');
  else if (c === 'sit') { if (pet.onGround) { setState('sit'); pet.sitUntil = T + 600; } }
  else if (c === 'stand') { if (pet.state === 'sit') setState('idle'); }
  else if (c === 'walk') { if (pet.onGround) setState('walk'); }
});
bridge.onSettings((s) => {
  const first = !settingsApplied;
  cfg = s;
  if (s.sizePx) sizePx = s.sizePx;
  if (typeof s.x === 'number' && first) pet.x = s.x;
  settingsApplied = true;
  if (voice) voice.set({ volume: s.volume ?? 0.6, pitch: s.pitch ?? 1 });
  layout();
  applyFigure(); applyFigureTextures();
  if (panelOpen) { renderPanel(); positionPanel(); }
  if (!first && !s.tourDone && !tourActive && model) { if (relay) disconnectRelay(); resetTradingState(); setTimeout(startTour, 600); }   // a reset from the panel
  if (first && s.autoConnect && !relay) setTimeout(connectRelay, 1500);
});
let settingsApplied = false;
bridge.onModel((m) => loadModel(m.buffer, m.name));

function doJump() {
  if (!pet.onGround) return;
  pet.onGround = false; pet.vy = 4.2; pet.vx = 0; pet.jumpFlag = true; pet.happy = 1;
  setState('falling');
  sound('jump');
}

function beginGrab(boneName) {
  // local (unrotated, root-relative) coordinates of the grab point
  const c = Math.cos(pet.theta), s = Math.sin(pet.theta);
  const rx = pet.x, ry = pet.y + pet.bob + pet.crouch;
  const dx = cursor.wx - rx, dy = cursor.wy - ry;
  const gx = c * dx + s * dy, gy = -s * dx + c * dy;
  pet.grab = { gx, gy, bone: boneName, px: cursor.wx, py: cursor.wy, pvx: 0, pvy: 0, ax: 0, ay: 0, shake: 0, wasOnGround: pet.onGround, prevState: pet.state };
  pet.onGround = false;
  pet.vx = 0; pet.vy = 0;
  pet.jumpFlag = false;
  setState('grabbed');
}

function releaseGrab() {
  if (!pet.grab) return;
  const g = pet.grab;
  tourFlag('throw');
  // throw velocity from the cursor's recent motion (px/s -> world/s)
  pet.vx = clamp(cursor.vx / ppu, -14, 14);
  pet.vy = clamp(-cursor.vy / ppu, -14, 14);
  if (Math.hypot(pet.vx, pet.vy) > 3.5) sound('throw');
  if (g.shake > 1) pet.dizzy = 1;
  pet.grab = null;
  setState('falling');
}

// ---------------------------------------------------------------- hit test
const _v = new THREE.Vector3();
function hitTest() {
  if (!model || !cursor.seen) return null;
  let best = null, bestD = Infinity;
  for (const n in HIT_R) {
    const b = model.bones[n];
    if (!b) continue;
    _v.setFromMatrixPosition(b.matrixWorld).project(camera);
    const sp = { x: canvasLeft + (_v.x + 1) / 2 * CS, y: canvasTop + (1 - _v.y) / 2 * CS };
    const hs = n === 'head' ? ((model.rawBones.head && model.rawBones.head.scale.y) || 1) : 1; // the Head slider scales it
    const r = Math.max(14, HIT_R[n] * hs * ppu * (model.height / 1.6) * 1.2);
    const d = Math.hypot(sp.x - cursor.sx, sp.y - cursor.sy);
    if (d < r && d - r < bestD) { bestD = d - r; best = n; }
  }
  return best;
}

// ---------------------------------------------------------------- pose system
const poseTarget = {};   // boneName -> [x,y,z] (radians)
const poseRate = {};     // boneName -> smoothing rate
const poseCur = {};      // boneName -> THREE.Quaternion
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
let defaultRate = 10;

function setPose(name, x, y, z, rate) {
  poseTarget[name] = [x, y, z];
  if (rate) poseRate[name] = rate;
}
function addPose(name, x, y, z) {
  const p = poseTarget[name] || (poseTarget[name] = [0, 0, 0]);
  p[0] += x; p[1] += y; p[2] += z;
}
function mixPose(name, x, y, z, w) {
  const p = poseTarget[name] || (poseTarget[name] = [0, 0, 0]);
  p[0] = lerp(p[0], x, w); p[1] = lerp(p[1], y, w); p[2] = lerp(p[2], z, w);
}

function restPose() {
  for (const n of BONE_NAMES) { poseTarget[n] = [0, 0, 0]; poseRate[n] = 0; }
  setPose('leftUpperArm', 0, 0, -1.18);
  setPose('rightUpperArm', 0, 0, 1.18);
  setPose('leftLowerArm', 0, -0.35, -0.1);
  setPose('rightLowerArm', 0, 0.35, 0.1);
  setPose('leftHand', 0, 0, -0.1);
  setPose('rightHand', 0, 0, 0.1);
}

function applyPose(dt) {
  for (const n in poseTarget) {
    const b = model.bones[n];
    if (!b) continue;
    const t = poseTarget[n], sg = model.sign;
    _e.set(t[0] * sg, t[1], t[2] * sg, 'XYZ');
    _q.setFromEuler(_e);
    const rate = poseRate[n] || defaultRate;
    let cur = poseCur[n];
    if (!cur) { cur = poseCur[n] = _q.clone(); }
    else cur.slerp(_q, 1 - Math.exp(-rate * dt));
    b.quaternion.copy(cur);
  }
}

// ---------------------------------------------------------------- expressions
const exprTarget = {};
const exprCur = {};
let blinkT = -1, nextBlinkAt = 2, blinkDouble = false;
let eyesClosed = 0;

function expr(name, w) { exprTarget[name] = Math.max(exprTarget[name] || 0, w); }

const exprAlias = {};
function exprName(em, n) {
  if (n in exprAlias) return exprAlias[n];
  let found = null;
  for (const cand of [n, n[0].toUpperCase() + n.slice(1), n.toUpperCase()]) {
    if (em.getExpression(cand)) { found = cand; break; }
  }
  return (exprAlias[n] = found);
}

// A blank face is most of the distance between a model and a character. She rests on a soft smile
// that drifts slowly so it never looks frozen, warms for a while after someone pays her attention,
// and gives way as she gets hurt — beaming through a black eye would read as broken, not cheerful.
function restingFace() {
  const hurt = pet.hurt || 0;
  const warm = clamp(1 - hurt * 1.2, 0, 1);
  const attn = clamp(1 - (T - pet.lastInteraction) / 25, 0, 1);
  const drift = 0.032 * Math.sin(T * 0.23) + 0.018 * Math.sin(T * 0.11 + 1.7);
  expr('relaxed', (0.22 + drift + 0.12 * attn) * warm);
  if (hurt > 0.25) expr('sad', clamp((hurt - 0.25) * 0.75, 0, 0.45));
}

function applyExpressions(dt) {
  const em = model.vrm.expressionManager;
  if (!em) return;
  restingFace();
  // auto blink
  if (blinkT < 0 && T > nextBlinkAt) { blinkT = 0; blinkDouble = Math.random() < 0.2; }
  let blink = 0;
  if (blinkT >= 0) {
    blinkT += dt;
    const d = 0.22;
    if (blinkT < d) blink = Math.sin(Math.PI * blinkT / d);
    else if (blinkDouble && blinkT < d * 2) blink = Math.sin(Math.PI * (blinkT - d) / d);
    else { blinkT = -1; nextBlinkAt = T + rand(1.5, 6); }
  }
  exprCur.__blink = damp(exprCur.__blink || 0, eyesClosed, 12, dt);
  blink = Math.max(blink, exprCur.__blink);
  for (const n of ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh']) {
    const tgt = exprTarget[n] || 0;
    exprCur[n] = damp(exprCur[n] || 0, tgt, 9, dt);
    const real = exprName(em, n);
    if (real) em.setValue(real, exprCur[n]);
  }
  if (em.getExpression('blink')) em.setValue('blink', clamp(blink, 0, 1));
  for (const n in exprTarget) exprTarget[n] = 0;
  eyesClosed = 0;
}

// ---------------------------------------------------------------- behaviour
function headLook(strength = 1) {
  // turn head towards the cursor (eyes are handled by vrm.lookAt)
  if (!cursor.seen) return;
  const hb = model.bones.head;
  _v.setFromMatrixPosition(hb.matrixWorld);
  const dx = cursor.wx - _v.x, dy = cursor.wy - _v.y, dz = 2.5;
  const dist = Math.hypot(dx, dy);
  const near = clamp(1 - (dist * ppu) / (W * 0.9), 0.35, 1); // farther cursor -> weaker turn
  let yaw = Math.atan2(dx, dz) - pet.yaw;
  let pitch = -Math.atan2(dy, Math.hypot(dx, dz));
  yaw = clamp(yaw * 0.55, -0.6, 0.6) * strength * near;
  pitch = clamp(pitch * 0.5, -0.35, 0.4) * strength * near;
  addPose('head', pitch * 0.7, yaw * 0.7, -yaw * 0.08);
  addPose('neck', pitch * 0.3, yaw * 0.3, 0);
}

// Standing perfectly square with the weight evenly on both feet is the clearest tell of a model
// placed in a scene rather than a girl standing on your taskbar. She leans on one hip and trades
// sides about every fifty seconds, with the spine counter-curving above it the way a real one does.
function contrapposto(scale = 1) {
  const w = Math.sin(T * 0.125) * scale;
  addPose('hips', 0, 0.02 * w, 0.05 * w);
  addPose('spine', 0, -0.012 * w, -0.032 * w);
  addPose('chest', 0, -0.008 * w, -0.018 * w);
  addPose('neck', 0, 0, 0.014 * w);
  addPose('head', 0, 0.022 * w, 0.030 * w);      // a small tilt, which reads as young and soft
  // the loose leg takes a little bend; the weighted one stays straight
  const loose = w > 0 ? 'left' : 'right';
  const k = Math.abs(w);
  addPose(loose + 'UpperLeg', 0.045 * k, 0, 0);
  addPose(loose + 'LowerLeg', -0.075 * k, 0, 0);
  addPose(loose + 'Foot', 0.03 * k, 0, 0);
}

function breathing(scale = 1) {
  const br = (0.8 * Math.sin(T * 1.55) + 0.2 * Math.sin(T * 3.1 + 0.6)) * scale;
  contrapposto(scale);
  addPose('chest', 0.025 * br, 0, 0);
  addPose('spine', 0.012 * br, 0, 0);
  addPose('leftShoulder', 0, 0, 0.02 * br);
  addPose('rightShoulder', 0, 0, -0.02 * br);
  addPose('leftUpperArm', 0, 0, 0.02 * br);
  addPose('rightUpperArm', 0, 0, -0.02 * br);
}

function idleMicro(dt) {
  if (!pet.micro) return;
  const m = pet.micro;
  m.t += dt;
  const w = envelope(m.t, m.dur, 0.6);
  if (m.name === 'stretch') {
    mixPose('leftUpperArm', -0.1, 0, 1.35, w);
    mixPose('rightUpperArm', -0.1, 0, -1.35, w);
    mixPose('leftLowerArm', 0, 0, 0.25, w);
    mixPose('rightLowerArm', 0, 0, -0.25, w);
    addPose('spine', -0.12 * w, 0, 0);
    addPose('head', -0.35 * w, 0, 0);
    expr('relaxed', w); eyesClosed = Math.max(eyesClosed, w);
    if (m.t > m.dur - 0.3) expr('happy', 0.5);
  } else if (m.name === 'lookaround') {
    addPose('head', 0, 0.55 * Math.sin(m.t * 1.6) * w, 0);
    addPose('chest', 0, 0.12 * Math.sin(m.t * 1.6) * w, 0);
  } else if (m.name === 'headtilt') {
    addPose('head', 0.05 * w, 0, 0.28 * w * m.side);
    expr('happy', 0.35 * w);
  } else if (m.name === 'sway') {
    const s = Math.sin(m.t * 2.2) * w;
    addPose('hips', 0, 0, 0.06 * s);
    addPose('spine', 0, 0, -0.04 * s);
    addPose('head', 0, 0, -0.05 * s);
  } else if (m.name === 'hum') {
    addPose('head', 0.03 * Math.sin(m.t * 5), 0, 0.12 * Math.sin(m.t * 2.5) * w);
    expr('happy', 0.5 * w);
    expr('ou', 0.25 * w * (0.5 + 0.5 * Math.sin(m.t * 5)));
  } else if (m.name === 'peek') {
    // leaning in to read whatever is on the screen above her — she lives under your charts
    addPose('spine', -0.10 * w, 0, 0);
    addPose('chest', -0.07 * w, 0, 0);
    addPose('head', -0.30 * w, 0.12 * m.side * w, 0);
    expr('surprised', 0.16 * w);
  } else if (m.name === 'fixhair') {
    // one hand up to tuck her hair back, then down again
    const side = m.side < 0 ? 'right' : 'left', k = m.side < 0 ? 1 : -1;
    const q = Math.sin(Math.PI * clamp(m.t / m.dur, 0, 1));   // rises and falls across the action
    mixPose(side + 'UpperArm', -0.30, 0, 0.95 * k, w * q);
    mixPose(side + 'LowerArm', 0, 1.30 * k, 0.80 * k, w * q);
    mixPose(side + 'Hand', 0, 0.22 * k, 0, w * q);
    addPose('head', 0.06 * w * q, -0.10 * k * w * q, 0.09 * k * w * q);
    expr('relaxed', 0.3 * w);
  } else if (m.name === 'think') {
    // knuckle near her chin, head tipped, eyes off to one side
    const side = m.side < 0 ? 'right' : 'left', k = m.side < 0 ? 1 : -1;
    mixPose(side + 'UpperArm', -0.12, 0, 0.50 * k, w);
    mixPose(side + 'LowerArm', 0, 1.72 * k, 0.50 * k, w);
    addPose('head', -0.10 * w, 0.20 * k * w, 0.13 * k * w);
    expr('relaxed', 0.35 * w);
  } else if (m.name === 'nod') {
    // agreeing with herself about something
    const n = Math.sin(m.t * 5.4) * w;
    addPose('head', 0.16 * n, 0, 0);
    addPose('chest', 0.03 * n, 0, 0);
    expr('happy', 0.3 * w);
  } else if (m.name === 'phone') {
    // pulls out a phone: both hands up in front, head down, thumb scrolling now and then
    const q = Math.sin(Math.PI * clamp(m.t / m.dur, 0, 1));
    const k = smoothstep(Math.min(m.t, m.dur - m.t) / 0.7);   // hands come up, stay, go down
    const [ux, uy, uz] = PHONE_TUNE.ua, [lx, ly, lz] = PHONE_TUNE.la, [hx, hy, hz] = PHONE_TUNE.hd;
    const scroll = 0.18 * Math.max(0, Math.sin(m.t * 5.5)) * (Math.sin(m.t * 0.9) > 0.3 ? 1 : 0);   // the thumb, now and then
    mixPose('leftUpperArm', ux, uy, -uz, k);          mixPose('rightUpperArm', ux, -uy, uz, k);
    mixPose('leftLowerArm', lx, -ly, -lz, k);         mixPose('rightLowerArm', lx, ly, lz, k);
    mixPose('leftHand', hx, hy, -hz, k);              mixPose('rightHand', hx + scroll, -hy, hz, k);
    addPose('head', PHONE_TUNE.head * k, 0, 0.04 * Math.sin(m.t * 0.7) * k);
    addPose('spine', 0.06 * k, 0, 0);
    expr('relaxed', 0.4 * k);
    if (Math.sin(m.t * 1.3 + 2) > 0.8) expr('happy', 0.5 * k);   // something funny on the timeline
    eyesClosed = Math.max(eyesClosed, 0.12 * k);
  } else if (m.name === 'shuffle') {
    // Shifts her weight and takes half a step to one side, the way anyone standing a while does.
    // Her left is the viewer's right, so a move to screen-right leads with her left foot.
    const q = Math.sin(Math.PI * clamp(m.t / m.dur, 0, 1));
    const k = m.side;
    if (pet.onGround && pet.state === 'idle') pet.x = clamp(pet.x + k * 0.05 * model.height * q * dt, minX, maxX);
    addPose('hips', 0, 0.05 * k * q, -0.07 * k * q);
    addPose('spine', 0, 0, 0.05 * k * q);
    addPose('head', 0, 0.06 * k * q, -0.03 * k * q);
    const lift = Math.sin(Math.PI * clamp((m.t - 0.35) / 0.9, 0, 1));   // the leading foot lifts and re-plants
    const leg = k > 0 ? 'left' : 'right';
    addPose(leg + 'UpperLeg', -0.30 * lift, 0, 0);
    addPose(leg + 'LowerLeg', 0.55 * lift, 0, 0);
    addPose(leg + 'Foot', 0.25 * lift, 0, 0);
    m.bob = 0.008 * model.height * lift;
  } else if (m.name === 'hop') {
    // A small hop on the spot: a dip, a beat in the air with the knees tucked, a soft landing.
    const T0 = 0.28, TA = 0.42;
    const dip = m.t < T0 ? Math.sin(Math.PI * m.t / T0) : 0;
    const air = m.t >= T0 && m.t < T0 + TA ? Math.sin(Math.PI * (m.t - T0) / TA) : 0;
    const land = m.t >= T0 + TA ? Math.sin(Math.PI * clamp((m.t - T0 - TA) / 0.45, 0, 1)) : 0;
    m.bob = 0.06 * model.height * air;
    m.crouch = -0.03 * model.height * (dip + 0.8 * land);
    const knee = 0.28 * (dip + land) + 0.45 * air, hipF = 0.14 * (dip + land) + 0.22 * air;
    for (const s of ['left', 'right']) {
      addPose(s + 'UpperLeg', -hipF, 0, 0);
      addPose(s + 'LowerLeg', knee, 0, 0);
    }
    addPose('spine', 0.08 * (dip + land), 0, 0);
    addPose('leftUpperArm', -0.15 * air, 0, 0.25 * air);
    addPose('rightUpperArm', -0.15 * air, 0, -0.25 * air);
    expr('happy', 0.5 * air);
  }
  if (m.t >= m.dur) { pet.micro = null; pet.nextActionAt = T + rand(3, 9); }
}

const lateHour = () => { const h = new Date().getHours(); return h >= 0 && h < 5; };
// Reflexes sit on top of whatever she is doing: a poke on the nose, a flinch from a hand that
// swings past too fast.
const FLINCH_SPEED = 2600;   // px/s of cursor motion near her that makes her flinch
function reflexes() {
  const st = pet.state;
  if (st === 'grabbed' || st === 'falling') return;
  // a fast hand near her
  if (cursor.seen && !cursor.down && T - pet.flinchAt > 3 && Math.hypot(cursor.vx, cursor.vy) > FLINCH_SPEED && cursorNear()) {
    pet.flinchAt = T; pet.lastInteraction = T;
    if (Math.random() < 0.5) sound('grab', { cooldown: 4, volume: 0.5 });
    if (st === 'sleep') setState('wake');
  }
  const f = T - pet.flinchAt;
  if (f < 0.6) {
    const w = envelope(f, 0.6, 0.12);
    mixPose('leftUpperArm', -0.9, 0.2, -0.6, w);   mixPose('rightUpperArm', -0.9, -0.2, 0.6, w);
    mixPose('leftLowerArm', 0, -1.5, -0.4, w);      mixPose('rightLowerArm', 0, 1.5, 0.4, w);
    addPose('head', -0.2 * w, 0, 0.1 * w); addPose('spine', 0.08 * w, 0, 0);
    eyesClosed = Math.max(eyesClosed, w); expr('surprised', 0.6 * w);
  }
  // a poke on the nose: a scrunch and a small jerk back
  const p = T - pet.pokeAt;
  if (p < 0.55) {
    const w = envelope(p, 0.55, 0.1);
    addPose('head', -0.16 * w, 0, 0.06 * w); addPose('neck', -0.06 * w, 0, 0);
    expr('ou', 0.7 * w); eyesClosed = Math.max(eyesClosed, 0.6 * w);
  }
}
function chooseIdleAction() {
  const idleFor = T - pet.lastInteraction;
  if (idleFor > 100 && Math.random() < 0.5 && pet.onGround) { setState('sit'); return; }
  const r = Math.random();
  if (r < (moodDown() ? 0.12 : 0.34) && !panelOpen) { setState('walk'); return; } // not while her settings are open
  // Anything that moves her arms is pointless while she is holding the board or hugging her
  // signPose runs after this and wins. Pick from what will actually be visible.
  const handsFree = !(sign && sign.phase !== 'hidden');
  // 'lookaround' and 'peek' appear twice: they are the least showy, so they carry the rotation
  // without any one of the bigger actions repeating often enough to notice.
  // 'shuffle' is in twice as well: it is the fidget that actually moves her, and a body that
  // never changes its footing reads as a statue. The hop needs her hands, or she would jump with the board.
  // Like the walk, the shuffle is off while her settings are open: the panel follows her, and a
  // slider that slides out from under the cursor mid-drag is maddening.
  let pool = (handsFree
    ? ['stretch', 'lookaround', 'headtilt', 'sway', 'hum', 'lookaround', 'peek', 'peek', 'fixhair', 'think', 'nod', 'shuffle', 'shuffle', 'hop', 'phone']
    : ['lookaround', 'headtilt', 'sway', 'hum', 'peek', 'peek', 'nod', 'lookaround', 'shuffle', 'shuffle']
  ).filter((n) => !(panelOpen && n === 'shuffle'));
  // mood: bouncy means more hops and humming; worried means the quiet ones only
  if (moodUp()) pool = pool.concat(handsFree ? ['hop', 'hop', 'hum'] : ['hum', 'sway']);
  if (moodDown()) pool = pool.filter((n) => !['hop', 'hum', 'stretch', 'fixhair', 'phone'].includes(n)).concat(['peek', 'headtilt']);
  const name = pick(pool);
  const dur = { stretch: 3.2, lookaround: 3.5, headtilt: 2.2, sway: 4, hum: 4,
    peek: 2.8, fixhair: 2.6, think: 3.8, nod: 2.0, shuffle: 2.4, hop: 1.15, phone: rand(7, 10) }[name];
  if (name === 'stretch' || name === 'hum') sound('stretch', { cooldown: 25, volume: 0.6 });
  if (name === 'hop') sound('jump', { cooldown: 30, volume: 0.45 });
  pet.micro = { name, t: 0, dur, side: Math.random() < 0.5 ? -1 : 1 };
}

// ---------------------------------------------------------------- physics
function pendulumStep(dt) {
  const g = pet.grab;
  // pivot chases the cursor with a stiff spring (smooths raw mouse steps)
  const npx = damp(g.px, cursor.wx, 28, dt), npy = damp(g.py, cursor.wy, 28, dt);
  const nvx = (npx - g.px) / dt, nvy = (npy - g.py) / dt;
  const ax = (nvx - g.pvx) / dt, ay = (nvy - g.pvy) / dt;
  g.ax = damp(g.ax, clamp(ax, -60, 60), 20, dt);
  g.ay = damp(g.ay, clamp(ay, -60, 60), 20, dt);
  g.px = npx; g.py = npy; g.pvx = nvx; g.pvy = nvy;
  g.shake = Math.max(0, g.shake * Math.exp(-dt * 0.6) + (Math.abs(ax) + Math.abs(ay)) * dt * 0.012);

  // rigid pendulum: body hangs from the grab point under gravity + pivot inertia
  const rx = -g.gx, ry = model.comY - g.gy;        // pivot -> centre of mass (local)
  const L2 = rx * rx + ry * ry;
  const c = Math.cos(pet.theta), s = Math.sin(pet.theta);
  const px = c * rx - s * ry, py = s * rx + c * ry;  // rotated
  const Fx = -g.ax, Fy = -G - g.ay;
  let alpha = 0;
  if (L2 > 0.01) alpha = (px * Fy - py * Fx) / L2;
  // damping scaled to the pendulum's natural frequency (~0.45 damping ratio):
  // one or two swings, then she settles instead of oscillating for seconds
  const w0 = Math.sqrt(G / Math.max(0.15, Math.sqrt(L2)));
  alpha -= pet.omega * (0.9 * w0 + 0.5);
  pet.omega = clamp(pet.omega + alpha * dt, -18, 18);
  pet.theta += pet.omega * dt;
  // keep theta in [-pi, pi]
  if (pet.theta > Math.PI) pet.theta -= Math.PI * 2;
  if (pet.theta < -Math.PI) pet.theta += Math.PI * 2;
  // place the root so the grab point sits at the pivot
  const c2 = Math.cos(pet.theta), s2 = Math.sin(pet.theta);
  pet.x = g.px - (c2 * g.gx - s2 * g.gy);
  pet.y = g.py - (s2 * g.gx + c2 * g.gy) - pet.bob - pet.crouch;
  pet.vx = nvx; pet.vy = nvy;
}

function airborneStep(dt) {
  pet.vy -= G * dt;
  pet.x += pet.vx * dt;
  pet.y += pet.vy * dt;
  // walls
  if (pet.x < minX) { pet.x = minX; pet.vx = Math.abs(pet.vx) * 0.45; pet.omega += 3; }
  if (pet.x > maxX) { pet.x = maxX; pet.vx = -Math.abs(pet.vx) * 0.45; pet.omega -= 3; }
  // she rights herself in the air (cat-like), softly
  const alpha = -22 * uprightError() - 4.5 * pet.omega;
  pet.omega += alpha * dt;
  pet.theta += pet.omega * dt;
  wrapTheta();
  if (pet.y <= groundY && pet.vy <= 0) {
    const impact = -pet.vy;
    pet.y = groundY; pet.onGround = true;
    pet.vy = 0; pet.vx *= 0.35;
    pet.squash.vel -= clamp(impact * 0.9, 0.4, 5.5);
    pet.landImpact = impact;
    if (pet.dizzy > 0 || impact > 9.5) { pet.dizzy = 1; setState('dizzy'); }
    else { setState('landing'); if (impact > 3) sound('land', { volume: clamp(impact / 8, 0.5, 1) }); }
    pet.jumpFlag = false;
    bridge.saveState({ x: pet.x });
  }
}

// restoring "error" toward upright; unlike sin() it never vanishes at 180°
function uprightError() {
  return Math.abs(pet.theta) > Math.PI / 2 ? Math.sign(pet.theta) : Math.sin(pet.theta);
}

function wrapTheta() {
  if (pet.theta > Math.PI) pet.theta -= Math.PI * 2;
  if (pet.theta < -Math.PI) pet.theta += Math.PI * 2;
}

function groundStep(dt) {
  // settle rotation and slide friction while on the ground
  wrapTheta();
  const alpha = -260 * uprightError() - 28 * pet.omega;
  pet.omega += alpha * dt;
  pet.theta += pet.omega * dt;
  if (Math.abs(pet.theta) < 0.002 && Math.abs(pet.omega) < 0.02) { pet.theta = 0; pet.omega = 0; }
  pet.x += pet.vx * dt;
  pet.vx *= Math.exp(-7 * dt);
  pet.x = clamp(pet.x, minX, maxX);
  pet.y = groundY;
}

// ---------------------------------------------------------------- per-state
function updateState(dt) {
  const st = pet.state;
  pet.t += dt;
  defaultRate = 10;
  restPose();
  let crouchTarget = 0, bobTarget = 0, yawTarget = 0;

  if (st === 'grabbed') {
    defaultRate = 14;
    if (!pet.grab) { setState('falling'); return; }
    pendulumStep(dt);
    const g = pet.grab;
    if (!g.said && pet.t > 0.3) { g.said = true; sound('grab'); }
    const lag = clamp(-pet.omega * 0.25, -0.7, 0.7);
    const kick = pet.t < 2.5 ? envelope(pet.t, 2.5, 0.4) : 0; // she struggles a bit at first
    const k1 = Math.sin(T * 9) * 0.35 * kick, k2 = Math.sin(T * 9 + Math.PI) * 0.35 * kick;
    setPose('leftUpperLeg', -0.15 + lag + k1, 0, 0);
    setPose('rightUpperLeg', -0.15 + lag + k2, 0, 0);
    setPose('leftLowerLeg', 0.35 + Math.max(0, -k1) * 1.2, 0, 0);
    setPose('rightLowerLeg', 0.35 + Math.max(0, -k2) * 1.2, 0, 0);
    // arms: the grabbed limb reaches toward the pivot, the other dangles
    const armLag = clamp(pet.omega * 0.18, -0.5, 0.5);
    if (g.bone.startsWith('left') && g.bone.includes('Arm') || g.bone === 'leftHand') {
      setPose('leftUpperArm', 0, 0, 1.4); setPose('leftLowerArm', 0, 0, 0.1);
    } else setPose('leftUpperArm', armLag, 0, -1.35 + 0.1 * Math.sin(T * 7) * kick);
    if (g.bone.startsWith('right') && g.bone.includes('Arm') || g.bone === 'rightHand') {
      setPose('rightUpperArm', 0, 0, -1.4); setPose('rightLowerArm', 0, 0, -0.1);
    } else setPose('rightUpperArm', armLag, 0, 1.35 - 0.1 * Math.sin(T * 7 + 1) * kick);
    if (g.bone.includes('Leg') || g.bone.includes('Foot')) {
      // held upside-down by a leg: that leg straight up, the other bent
      const left = g.bone.startsWith('left');
      setPose(left ? 'leftUpperLeg' : 'rightUpperLeg', 0.1, 0, 0);
      setPose(left ? 'leftLowerLeg' : 'rightLowerLeg', 0.05, 0, 0);
    }
    addPose('spine', 0.05 - lag * 0.15, 0, 0);
    addPose('head', -0.15 - lag * 0.2, 0, 0);
    headLook(0.6);
    // expressions: surprised when picked up, then a pout; dizzy if shaken
    if (pet.t < 0.9) { expr('surprised', envelope(pet.t, 0.9, 0.15)); expr('oh', 0.4 * envelope(pet.t, 0.9, 0.15)); }
    else { expr('sad', 0.25); expr('relaxed', 0.15); }
    if (g.shake > 0.6) { eyesClosed = Math.max(eyesClosed, clamp((g.shake - 0.6) * 2, 0, 1)); expr('ou', clamp(g.shake - 0.5, 0, 0.7)); }
    if (Math.abs(pet.omega) > 6) { expr('surprised', 0.6); }
  }

  else if (st === 'falling') {
    defaultRate = 12;
    airborneStep(dt);
    if (pet.state !== 'falling') return; // landed this frame
    const fl = Math.sin(T * 13), fl2 = Math.sin(T * 13 + 2);
    if (pet.jumpFlag) {
      setPose('leftUpperArm', -0.2, 0, 1.2); setPose('rightUpperArm', -0.2, 0, -1.2);
      setPose('leftLowerArm', 0, 0, 0.3); setPose('rightLowerArm', 0, 0, -0.3);
      setPose('leftUpperLeg', -0.3, 0, 0); setPose('rightUpperLeg', -0.3, 0, 0);
      setPose('leftLowerLeg', 0.9, 0, 0); setPose('rightLowerLeg', 0.9, 0, 0);
      expr('happy', 1);
    } else {
      setPose('leftUpperArm', 0.2 * fl, 0, 0.7 + 0.5 * fl);
      setPose('rightUpperArm', 0.2 * fl2, 0, -0.7 - 0.5 * fl2);
      setPose('leftLowerArm', 0, -0.3, 0.6 + 0.3 * fl2);
      setPose('rightLowerArm', 0, 0.3, -0.6 - 0.3 * fl);
      setPose('leftUpperLeg', -0.35 + 0.25 * fl, 0, 0);
      setPose('rightUpperLeg', -0.35 - 0.25 * fl, 0, 0);
      setPose('leftLowerLeg', 0.6 + 0.3 * fl2, 0, 0);
      setPose('rightLowerLeg', 0.6 - 0.3 * fl2, 0, 0);
      addPose('spine', 0.15, 0, 0);
      addPose('head', -0.1, 0, 0);
      const fast = clamp((-pet.vy - 2) / 5, 0, 1);
      expr('surprised', 1); expr('oh', 0.6);
      eyesClosed = Math.max(eyesClosed, fast);
    }
    if (pet.dizzy) { eyesClosed = 1; expr('ou', 0.6); }
  }

  else if (st === 'landing') {
    defaultRate = 18;
    groundStep(dt);
    const w = envelope(pet.t, 0.7, 0.18);
    const hard = clamp((pet.landImpact || 0) / 6, 0.3, 1);
    crouchTarget = -0.16 * w * hard * model.height;
    setPose('leftUpperLeg', -0.85 * w * hard, 0.15 * w, 0.1 * w);
    setPose('rightUpperLeg', -0.85 * w * hard, -0.15 * w, -0.1 * w);
    setPose('leftLowerLeg', 1.5 * w * hard, 0, 0);
    setPose('rightLowerLeg', 1.5 * w * hard, 0, 0);
    setPose('leftFoot', -0.5 * w * hard, 0, 0);
    setPose('rightFoot', -0.5 * w * hard, 0, 0);
    setPose('leftUpperArm', -0.3 * w, 0, -0.55 - 0.6 * (1 - w));
    setPose('rightUpperArm', -0.3 * w, 0, 0.55 + 0.6 * (1 - w));
    addPose('spine', 0.35 * w * hard, 0, 0);
    addPose('head', -0.25 * w * hard, 0, 0);
    expr('oh', 0.6 * w); expr('surprised', 0.4 * w);
    if (pet.t > 0.75) { setState('idle'); if (pet.happy) pet.happy = 0; }
  }

  else if (st === 'dizzy') {
    defaultRate = 9;
    groundStep(dt);
    const w = envelope(pet.t, 2.8, 0.4);
    const ph = pet.t * 5.5;
    addPose('head', 0.2 * Math.sin(ph) * w, 0.1 * Math.cos(ph) * w, 0.3 * Math.cos(ph) * w);
    addPose('spine', 0.05 * Math.sin(ph) * w, 0, 0.1 * Math.cos(ph) * w);
    addPose('hips', 0, 0, -0.06 * Math.cos(ph) * w);
    setPose('leftUpperArm', 0.2 * Math.sin(ph), 0, -0.8);
    setPose('rightUpperArm', -0.2 * Math.sin(ph), 0, 0.8);
    setPose('leftLowerArm', 0, -0.4, 0.3); setPose('rightLowerArm', 0, 0.4, -0.3);
    setPose('leftUpperLeg', -0.1, 0.2, 0.1); setPose('rightUpperLeg', -0.1, -0.2, -0.1);
    setPose('leftLowerLeg', 0.25, 0, 0); setPose('rightLowerLeg', 0.25, 0, 0);
    crouchTarget = -0.03 * model.height * w;
    eyesClosed = Math.max(eyesClosed, w);
    expr('ou', 0.7 * w); expr('sad', 0.3 * w);
    if (pet.t > 2.8) { pet.dizzy = 0; setState('idle'); }
  }

  else if (st === 'wave') {
    groundStep(dt);
    const w = envelope(pet.t, 1.8, 0.35);
    mixPose('rightUpperArm', -0.1, 0, -0.55, w);
    mixPose('rightLowerArm', 0, 0.2, -1.35 + 0.4 * Math.sin(pet.t * 13), w);
    mixPose('rightHand', 0, 0, -0.2 * Math.sin(pet.t * 13), w);
    addPose('head', 0.02, 0, 0.18 * w);
    addPose('spine', 0, 0, 0.04 * w);
    breathing(1);
    headLook(1);
    expr('happy', w);
    if (pet.t > 1.8) setState('idle');
  }

  else if (st === 'walk') {
    groundStep(dt);
    defaultRate = 12;
    const speed = 0.6 * (model.height / 1.6);
    const cadence = 0.95;                       // stride cycles per second at full speed
    const legLen = model.hipH * 0.95;
    const dx = pet.walkTarget - pet.x;
    const dir = Math.sign(dx) || 1;
    const arriving = clamp(Math.abs(dx) / 0.45, 0, 1);
    const starting = smoothstep(pet.t / 0.7);
    const v = speed * smoothstep(arriving) * starting;
    pet.x += dir * v * dt;
    pet.facing = dir;
    yawTarget = dir * 0.95;
    // phase advances with distance travelled so the feet never slide
    const strideLen = speed / (2 * cadence);
    const amp = Math.asin(clamp(strideLen / 2 / legLen, 0, 0.8));
    pet.walkPhase += dt * 2 * Math.PI * cadence * (v / speed);
    const ph = pet.walkPhase, sn = Math.sin(ph), cs = Math.cos(ph), w = clamp(v / speed, 0, 1);
    const kneeL = 0.9 * Math.max(0, cs), kneeR = 0.9 * Math.max(0, -cs);
    setPose('leftUpperLeg', -amp * sn * w - 0.02, 0.03, 0.02);
    setPose('rightUpperLeg', amp * sn * w - 0.02, -0.03, -0.02);
    setPose('leftLowerLeg', (kneeL * w) * (amp * 3) + 0.06, 0, 0);
    setPose('rightLowerLeg', (kneeR * w) * (amp * 3) + 0.06, 0, 0);
    setPose('leftFoot', 0.35 * Math.max(0, -sn) * w - 0.05 * Math.max(0, cs) * w, 0, 0);
    setPose('rightFoot', 0.35 * Math.max(0, sn) * w - 0.05 * Math.max(0, -cs) * w, 0, 0);
    // arms swing opposite to the legs, elbows flex when the arm comes forward
    addPose('leftUpperArm', 0.28 * sn * w, 0.05 * w, 0.05 * w);
    addPose('rightUpperArm', -0.28 * sn * w, -0.05 * w, -0.05 * w);
    addPose('leftLowerArm', 0, -0.18 * Math.max(0, -sn) * w, 0);
    addPose('rightLowerArm', 0, 0.18 * Math.max(0, sn) * w, 0);
    // pelvis sways onto the stance leg, chest counter-rotates, head stays level
    addPose('hips', 0, 0.07 * sn * w, 0.045 * cs * w);
    addPose('spine', 0.05 * w, -0.05 * sn * w, -0.02 * cs * w);
    addPose('chest', 0.02 * w, -0.05 * sn * w, -0.015 * cs * w);
    addPose('head', 0.015 * Math.cos(2 * ph) * w, 0.04 * sn * w, -0.01 * cs * w);
    bobTarget = 0.014 * model.height * (1 - Math.cos(2 * ph)) * 0.5 * w;
    breathing(0.5);
    headLook(0.5);
    if (Math.random() < dt * 0.3) expr('happy', 0.3);
    if (Math.abs(dx) < 0.03 || pet.t > 30) { pet.x = pet.walkTarget; setState('idle'); bridge.saveState({ x: pet.x }); }
  }

  else if (st === 'sit') {
    // seiza: kneel with shins folded back, hands resting on the thighs
    defaultRate = 5;
    groundStep(dt);
    const w = smoothstep(pet.t / 1.3);
    crouchTarget = -model.hipH * 0.52 * w;
    mixPose('leftUpperLeg', -0.32, 0.1, 0.06, w);
    mixPose('rightUpperLeg', -0.32, -0.1, -0.06, w);
    mixPose('leftLowerLeg', 2.35, 0, 0, w);
    mixPose('rightLowerLeg', 2.35, 0, 0, w);
    mixPose('leftFoot', 0.75, 0, 0, w);
    mixPose('rightFoot', 0.75, 0, 0, w);
    mixPose('leftUpperArm', 0.55, 0.1, -1.05, w);
    mixPose('rightUpperArm', 0.55, -0.1, 1.05, w);
    mixPose('leftLowerArm', 0, -0.75, -0.2, w);
    mixPose('rightLowerArm', 0, 0.75, 0.2, w);
    mixPose('leftHand', 0.4, 0, -0.1, w);
    mixPose('rightHand', 0.4, 0, 0.1, w);
    addPose('spine', 0.05 * w, 0, 0);
    addPose('head', 0.04 * w, 0, 0.04 * Math.sin(T * 0.8) * w);
    breathing(1.2);
    headLook(0.9);
    expr('relaxed', 0.55 * w);
    idleMicro(dt);
    if (!pet.micro && T > pet.nextActionAt) {
      pet.micro = { name: pick(['lookaround', 'headtilt', 'hum', 'sway']), t: 0, dur: 3.5, side: Math.random() < 0.5 ? -1 : 1 };
    }
    if (T > pet.sitUntil) setState('idle');
  }

  else if (st === 'sleep') {
    // dozed off kneeling: head drooping, eyes shut, slow breath, the odd "zzz"; a trade or a
    // touch wakes her with a jolt
    defaultRate = 3;
    groundStep(dt);
    const w = smoothstep(pet.t / 2.5);
    crouchTarget = -model.hipH * 0.52 * w;
    mixPose('leftUpperLeg', -0.32, 0.1, 0.06, w);   mixPose('rightUpperLeg', -0.32, -0.1, -0.06, w);
    mixPose('leftLowerLeg', 2.35, 0, 0, w);         mixPose('rightLowerLeg', 2.35, 0, 0, w);
    mixPose('leftFoot', 0.75, 0, 0, w);             mixPose('rightFoot', 0.75, 0, 0, w);
    mixPose('leftUpperArm', 0.5, 0.1, -1.1, w);     mixPose('rightUpperArm', 0.5, -0.1, 1.1, w);
    mixPose('leftLowerArm', 0, -0.6, -0.15, w);     mixPose('rightLowerArm', 0, 0.6, 0.15, w);
    const nod = 0.06 * Math.sin(T * 0.9);
    addPose('spine', 0.22 * w, 0, 0);
    addPose('head', (0.55 + nod) * w, 0, 0.12 * w);
    breathing(0.6);
    eyesClosed = Math.max(eyesClosed, w);
    expr('relaxed', 0.6 * w);
    if (T - pet.sleepSaidAt > 25) { pet.sleepSaidAt = T; say(pick(['…zzz', 'zzz…', '…mm… zzz']), 4); sound('stretch', { cooldown: 60, volume: 0.35 }); }
    if (cursorNear() && cursor.seen && T - cursor.lastT < 0.5) pet.wakeNear = (pet.wakeNear || 0) + dt; else pet.wakeNear = 0;
    if (pet.wakeNear > 0.6 || T - pet.lastInteraction < 1) setState('wake');
  }

  else if (st === 'wake') {
    // the jolt: eyes wide, head up, hands up, then she gathers herself
    defaultRate = 18;
    groundStep(dt);
    const w = envelope(pet.t, 0.9, 0.12);
    mixPose('leftUpperArm', -0.6, 0, -0.5, w);   mixPose('rightUpperArm', -0.6, 0, 0.5, w);
    mixPose('leftLowerArm', 0, -1.4, -0.2, w);    mixPose('rightLowerArm', 0, 1.4, 0.2, w);
    addPose('head', -0.25 * w, 0, 0.1 * w);
    addPose('spine', -0.08 * w, 0, 0);
    expr('surprised', w); expr('oh', 0.5 * w);
    if (pet.t > 0.9) { setState('idle'); say(pick(['…I was awake!', 'Mm? I am here!', 'Un!']), 3); }
  }

  else if (st === 'gasp') {
    // a coin she holds just ran: hands fly to her cheeks, then she points at the board
    groundStep(dt);
    defaultRate = 16;
    const w = envelope(pet.t, 2.4, 0.2);
    const point = smoothstep((pet.t - 0.8) / 0.4);
    const held = sign && sign.mesh.visible, two = held && sign.two;
    const side = held ? sign.side : -1;                              // the board hangs on her right (side < 0) or left
    const k = side < 0 ? 1 : -1;
    if (!two) {
      // the free hand flies to her cheek, then points at the board; the holding arm is signPose's
      const fa = side < 0 ? 'left' : 'right', fk = -k;
      mixPose(fa + 'UpperArm', lerp(-0.3, -1.1, point), 0, lerp(0.95 * fk, 0.25 * k, point), w);
      mixPose(fa + 'LowerArm', 0, lerp(1.7 * fk, 0.15 * fk, point), lerp(0.5 * fk, 0, point), w);
      mixPose(fa + 'Hand', lerp(0.2, 0, point), 0, 0, w);
    }
    addPose('head', -0.16 * w, 0.14 * k * point * w, 0.08 * w);
    addPose('spine', -0.1 * w + (two ? -0.06 * point * w : 0), 0.08 * k * point * w, 0);   // both hands: she thrusts the board up at you
    bobTarget = 0.03 * model.height * Math.max(0, Math.sin(pet.t * 9)) * (pet.t < 0.7 ? w : 0);   // a little bounce on the gasp
    expr('surprised', w); expr('aa', 0.6 * w); expr('happy', 0.4 * point * w);
    headLook(0.2);
    if (pet.t > 2.4) setState('idle');
  }

  else if (st === 'wince') {
    // a coin she holds is dumping: eyes screwed shut, shoulders up, board pulled in close
    groundStep(dt);
    defaultRate = 12;
    const w = envelope(pet.t, 2.6, 0.3);
    mixPose('leftShoulder', -0.1, 0, 0.25, w); mixPose('rightShoulder', -0.1, 0, -0.25, w);
    mixPose('leftUpperArm', -0.2, 0.3, -0.55, w);   mixPose('rightUpperArm', -0.2, -0.3, 0.55, w);
    mixPose('leftLowerArm', 0.1, -1.6, -0.3, w);     mixPose('rightLowerArm', 0.1, 1.6, 0.3, w);
    crouchTarget = -0.02 * model.height * w;
    addPose('spine', 0.14 * w, 0, 0.05 * w);
    addPose('head', 0.2 * w, 0.2 * w, -0.14 * w);
    eyesClosed = Math.max(eyesClosed, 0.85 * w);
    expr('ih', 0.6 * w); expr('sad', 0.5 * w);
    if (pet.t > 2.6) setState('idle');
  }

  else if (st === 'guard') {
    // hands on hips, head tilted, one eyebrow up. It is a look, not a lecture.
    groundStep(dt);
    defaultRate = 9;
    const w = envelope(pet.t, 3.0, 0.4);
    mixPose('leftUpperArm', 0.1, 0.55, -0.95, w);   mixPose('rightUpperArm', 0.1, -0.55, 0.95, w);
    mixPose('leftLowerArm', 0, -1.35, -0.9, w);     mixPose('rightLowerArm', 0, 1.35, 0.9, w);
    mixPose('leftHand', -0.3, 0, 0.2, w);           mixPose('rightHand', -0.3, 0, -0.2, w);
    addPose('hips', 0, 0, 0.07 * w);
    addPose('spine', -0.04 * w, 0, -0.05 * w);
    addPose('head', -0.05 * w, 0.12 * w, 0.22 * w);
    expr('angry', 0.28 * w); expr('relaxed', 0.3 * w);
    eyesClosed = Math.max(eyesClosed, 0.28 * w);
    headLook(1);
    if (pet.t > 3.0) setState('idle');
  }

  else if (st === 'cheer') {
    // profit: two big excited jumps, knees tucked in the air, arms thrown up, mouth open
    groundStep(dt);
    defaultRate = 16;
    const w = envelope(pet.t, 2.8, 0.25);
    const ph = pet.t * 4.6;                                   // ~0.7 s per jump
    const air = pet.t < 2.0 ? Math.max(0, Math.sin(ph)) : 0;  // up in the air
    const dip = pet.t < 2.0 ? Math.max(0, -Math.sin(ph)) * 0.6 : 0;   // the crouch between jumps
    bobTarget = 0.16 * model.height * air * w;
    crouchTarget = -0.035 * model.height * dip * w;
    for (const s of ['left', 'right']) {
      setPose(s + 'UpperLeg', -0.55 * air * w - 0.18 * dip * w, 0, 0);   // knees up in the air, bent in the crouch
      setPose(s + 'LowerLeg', 1.05 * air * w + 0.35 * dip * w, 0, 0);
      setPose(s + 'Foot', 0.35 * air * w, 0, 0);
    }
    mixPose('leftUpperArm', -0.3, 0, 1.55 + 0.2 * Math.sin(ph), w);
    mixPose('rightUpperArm', -0.3, 0, -1.55 - 0.2 * Math.sin(ph + 1), w);
    mixPose('leftLowerArm', 0, 0, 0.3, w); mixPose('rightLowerArm', 0, 0, -0.3, w);
    mixPose('leftHand', 0, 0, 0.2, w); mixPose('rightHand', 0, 0, -0.2, w);
    addPose('head', -0.14 * w, 0, 0.2 * Math.sin(pet.t * 4.5) * w);
    addPose('spine', -0.08 * w + 0.1 * dip * w, 0, 0.03 * Math.sin(pet.t * 4.5) * w);
    expr('happy', w); expr('aa', 0.45 * air * w);
    headLook(0.3);
    if (pet.t > 2.8) setState('idle');
  }

  else if (st === 'comfort') {
    // loss: she is sad. Head hung, shoulders in, hands together low, a couple of sobs, and the
    // face stays sad for the whole of it — she does not cheer up on her own.
    groundStep(dt);
    defaultRate = 5;
    const w = envelope(pet.t, 4.6, 0.7);
    // arms hanging close to her, swung a little forward, forearms turned in so the hands meet low in front
    const [ux, uy, uz] = SAD_TUNE.ua, [lx, ly, lz] = SAD_TUNE.la, [hx, hy, hz] = SAD_TUNE.hd;
    mixPose('leftUpperArm', ux, uy, -uz, w);   mixPose('rightUpperArm', ux, -uy, uz, w);
    mixPose('leftLowerArm', lx, -ly, -lz, w);  mixPose('rightLowerArm', lx, ly, lz, w);
    mixPose('leftHand', hx, hy, -hz, w);       mixPose('rightHand', hx, -hy, hz, w);
    mixPose('leftShoulder', 0.12, 0, 0.16, w); mixPose('rightShoulder', 0.12, 0, -0.16, w);   // slumped
    // two sobs, a short shoulder shudder each
    const sob = (pet.t > 1.2 && pet.t < 1.7) || (pet.t > 2.6 && pet.t < 3.1) ? Math.sin(pet.t * 28) * 0.03 : 0;
    addPose('spine', 0.2 * w, 0, sob);
    addPose('chest', 0.1 * w + sob, 0, 0);
    addPose('head', 0.42 * w, 0, 0.12 * w * (pet.comfortSide || 1));
    expr('sad', 0.75 * w); eyesClosed = Math.max(eyesClosed, 0.35 * w);
    if (!pet.cheeredUp && pet.t > 3.4) { pet.cheeredUp = true; sound('cheerUp', { volume: 0.8 }); }   // a small "ganbatte" to herself at the end
    headLook(0.3);
    if (pet.t > 4.6) setState('idle');
  }

  else if (st === 'notice') {
    // buy / neutral sell: perks up, finger to chin
    groundStep(dt);
    defaultRate = 10;
    const w = envelope(pet.t, 1.8, 0.3);
    mixPose('rightUpperArm', -1.0, -0.35, 0.75, w);
    mixPose('rightLowerArm', 0.2, 0.6, -1.55, w);
    mixPose('rightHand', 0.5, 0, -0.5, w);
    addPose('head', -0.06 * w, 0.12 * w, 0.14 * w);
    addPose('spine', -0.03 * w, 0.06 * w, 0);
    expr('surprised', 0.35 * w); expr('happy', 0.25 * w);
    headLook(1);
    if (pet.t > 1.8) setState('idle');
  }

  else { // idle
    groundStep(dt);
    defaultRate = 7;
    const n1 = noise(T * 0.35), n2 = noise(T * 0.27 + 7), n3 = noise(T * 0.5 + 13);
    addPose('hips', 0.01 * n2, 0.06 * n1, 0.03 * n2);
    addPose('spine', 0.015 * n3, -0.03 * n1, -0.02 * n2);
    addPose('chest', 0, -0.02 * n1, -0.01 * n2);
    addPose('leftUpperLeg', 0.02 * n2, 0.03 * n1, 0.01 * n2);
    addPose('rightUpperLeg', -0.02 * n2, 0.03 * n1, 0.01 * n2);
    addPose('leftUpperArm', 0.03 * n3, 0, 0.02 * n1);
    addPose('rightUpperArm', 0.03 * n2, 0, -0.02 * n1);
    addPose('head', 0.03 * n3, 0.05 * n2, 0.02 * n1);
    breathing(1);
    headLook(1);
    idleMicro(dt);
    if (pet.micro) { bobTarget += pet.micro.bob || 0; crouchTarget += pet.micro.crouch || 0; }
    // attention: cursor lingering on her makes her happy
    if (cursor.hit) { pet.hoverTime += dt; } else pet.hoverTime = Math.max(0, pet.hoverTime - dt * 2);
    if (pet.hoverTime > 0.6) sound('hover', { cooldown: 12, volume: 0.7 });
    if (pet.hoverTime > 0.35) {
      const w = clamp((pet.hoverTime - 0.35) / 0.6, 0, 1);
      expr('happy', 0.65 * w);
      addPose('head', 0, 0, 0.12 * w * (cursor.wx > pet.x ? -1 : 1));
      // a hand resting on her head: she leans into it
      if (cursor.hit === 'head' && pet.hoverTime > 1.2) {
        const l = clamp((pet.hoverTime - 1.2) / 0.8, 0, 1) * (cursor.wx > pet.x ? -1 : 1);
        addPose('head', 0.12 * Math.abs(l), 0, 0.22 * l); addPose('neck', 0.05 * Math.abs(l), 0, 0.08 * l);
        expr('relaxed', 0.6 * Math.abs(l)); eyesClosed = Math.max(eyesClosed, 0.5 * Math.abs(l));
      }
    }
    // mood on her face while nothing else is going on
    if (moodUp()) expr('happy', 0.3 * pet.mood);
    if (moodDown()) { expr('sad', 0.35 * -pet.mood); addPose('head', 0.08 * -pet.mood, 0, 0); }
    // the small hours: heavy eyes
    if (lateHour()) eyesClosed = Math.max(eyesClosed, 0.3);
    // turn slightly toward a nearby cursor
    if (cursor.seen) {
      const d = (cursor.wx - pet.x) * ppu;
      if (Math.abs(d) < 420 && Math.abs(cursor.wy - pet.y) * ppu < sizePx * 1.4) yawTarget = clamp(d / 300, -1, 1) * 0.45;
      else yawTarget = 0.12 * n1;
    }
    if (!pet.micro && T > pet.nextActionAt) chooseIdleAction();
  }

  reflexes();
  if (pet.happy > 0) { expr('happy', pet.happy); pet.happy = Math.max(0, pet.happy - dt * 0.7); }
  signPose();
  if (pet.glow > 0) expr('happy', 0.35 * pet.glow);
  if (pet.hurt > 0.15 && st === 'idle') expr('sad', 0.22 * pet.hurt);

  // presenting a sign in both hands: square up to the viewer, or her hands turn off the board
  if (sign && sign.two && sign.phase !== 'hidden') yawTarget *= 0.15;
  pet.yaw = damp(pet.yaw, yawTarget, 4, dt);
  pet.crouch = damp(pet.crouch, crouchTarget, st === 'sit' ? 5 : 16, dt);
  pet.bob = damp(pet.bob, bobTarget, 20, dt);
}

// ---------------------------------------------------------------- PnL sign
// She keeps a stack of little signs behind her back. When you open a position she reaches
// back, pulls one out and holds it up: the ticker, the unrealised PnL on that position, and
// the percentage. Every trade on that token anywhere in the market re-prices it (the relay
// forwards a throttled price tick for mints you hold). When you go flat she swaps it for a
// session-total sign; when the relay is off she puts it away.
const positions = new Map();   // mint -> { mint, tokens, cost, quote, symbol, price, at }
let sessionPnl = 0, sessionTrades = 0, sessionQuote = 'SOL';
let signDismissedId = null;   // the board the user closed by hand; shown again when the content changes
let lastTradeAt = -99;        // so the session board is put away once it is old news
const SESSION_SHOW = 25;      // seconds the session total stays up after your last fill
// Mints we watched open this session. A relay reconnect resends them as seeded history, and
// without this they would stop counting as "live" and her board would silently vanish.
const liveMints = new Set();
let demoPos = null;           // "Test position": a fake bag whose market cap wanders, so the board moves
const DEMO_SECS = 30;
const DEMO_SYMS = ['YUI', 'PEPE', 'WIF', 'BONK', 'MOON', 'GIGA', 'WOJAK', 'CHAD'];
function toggleDemoSign() {
  if (demoPos) { demoPos = null; return false; }
  const entryMc = rand(18, 240);
  demoPos = { symbol: pick(DEMO_SYMS), cost: rand(0.35, 3.2), quote: 'SOL', entryMc, seed: Math.random() * 100, until: T + DEMO_SECS };
  signDismissedId = null;
  return true;
}
function demoContent() {
  if (!demoPos) return null;
  if (T > demoPos.until) { demoPos = null; return null; }
  const mc = demoPos.entryMc * (1 + 0.55 * noise(T * 0.55 + demoPos.seed));
  const value = demoPos.cost * (mc / demoPos.entryMc);
  const pnl = value - demoPos.cost;
  const pct = (pnl / demoPos.cost) * 100;
  return {
    id: 'demo',
    title: '$' + demoPos.symbol,
    amount: (pnl >= 0 ? '+' : '\u2212') + signMoney(pnl, demoPos.quote),
    sub: `${pct >= 0 ? '+' : '\u2212'}${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`,
    foot: mcText(mc, demoPos.quote) + ' \u00b7 demo',
    tone: pnl > 1e-9 ? 1 : pnl < -1e-9 ? -1 : 0,
  };
}

const SIGN_W = 1024, SIGN_H = 780;         // sign texture, board + post
const SIGN_PULL = 0.75, SIGN_STASH = 0.45; // seconds
// Buying several tokens in a row would otherwise leave her endlessly swapping boards and never
// showing one long enough to read. A board earns a minimum time up before it can be replaced.
const SIGN_MIN_HOLD = 2.2;
// upper arm / forearm / wrist, for the arm that is holding it
const HOLD_POSES = [
  { ua: [-0.34, -0.12, 0.46], la: [-0.10, -0.18, -1.34], hd: [0, 0, -0.10] }, // up by her shoulder
  { ua: [-0.30, -0.10, 0.10], la: [-0.06, -0.14, -1.52], hd: [0, 0, -0.06] }, // high, beside her head
  { ua: [-0.26, -0.16, 0.76], la: [-0.18, -0.22, -1.10], hd: [0, 0, -0.14] }, // low, at her chest
  { ua: [-0.48, -0.06, 0.34], la: [-0.04, -0.10, -1.00], hd: [0, 0, -0.08] }, // held out in front
];
let GRIP_TUNE = { axis: 2, amt: -1.15, roll: -1.1 };
let TWO_GRIP = { amt: 1.15, roll: -1.50 };    // fingers curl ONTO the board face, not away from it
// both arms, holding the board in front of her: mirrored onto each side
// shoulders near rest so the hands stay wide enough to reach both edges; the forward reach
// comes from the elbows, which barely narrows them
// the wrist roll matters: without it her palms face up and the hands read upside down
let HOLD_TWO = { ua: [0, 0, 0.45], la: [0, 1.30, 0.70], hd: [-1.50, 0, 0] };
// the loss pose's arms (right side; the left is mirrored): upper arm, forearm, hand
let SAD_TUNE = { ua: [-0.5, 0.1, 1.12], la: [0, 1.0, 0.9], hd: [0.3, 0, 0.2] };
// the phone pose's arms (right side; the left is mirrored) and how far the head drops to it
let PHONE_TUNE = { ua: [-1.0, 0.1, 0.8], la: [0, 0.8, 1.15], hd: [-0.9, 0, 0.3], head: 0.55 };
let TWO_BOTTOM = 0.40;   // board bottom, in body heights above her feet (over her stomach, under the bust)
let TWO_FWD = 0.10;      // just clear of her stomach (measured front surface ~0.083)
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
// close the fist round the post; the post is drawn passing through it
function gripHand(side, w) {
  if (w <= 0.01) return;
  const m = side === 'right' ? 1 : -1;
  const ax = GRIP_TUNE.axis, a = (sign && sign.two) ? TWO_GRIP.amt : GRIP_TUNE.amt;
  const v = (k) => { const o = [0, 0, 0]; o[ax] = k * a * m; return o; };
  for (const f of FINGERS) {
    mixPose(side + f + 'Proximal', ...v(1.0), w);
    mixPose(side + f + 'Intermediate', ...v(1.25), w);
    mixPose(side + f + 'Distal', ...v(0.7), w);
  }
  mixPose(side + 'ThumbProximal', ...v(0.45), w);
  mixPose(side + 'ThumbIntermediate', ...v(0.6), w);
  mixPose(side + 'ThumbDistal', ...v(0.5), w);
}
let sign = null; // { mesh, canvas, ctx, tex, phase, t, id, text, drawnAt, next }

function resetTradingState() {
  positions.clear();
  sessionPnl = 0; sessionTrades = 0; sessionQuote = 'SOL';
}

function applyPosition(mint, o) {
  if (!(o.tokens > 0)) { positions.delete(mint); return; }
  const p = positions.get(mint) || { mint, price: 0, at: 0, invSum: 0, mc: 0, openedAt: T };
  Object.assign(p, o);
  if (!(p.price > 0) && p.cost > 0) p.price = p.cost / p.tokens; // no tick yet: start flat
  positions.set(mint, p);
}

// the position to show: the most recently traded one we actually watched open. Bags that were
// already there when the relay connected are tracked for PnL but never raise a sign on their own.
function livePosition() {
  let best = null;
  for (const p of positions.values()) if (p.tokens > 0 && p.live && (!best || p.at > best.at)) best = p;
  return best;
}

// Dollars are the only market cap a viewer reads at a glance. The relay sends it in dollars
// (`mcUsd`) priced from the pair's real quote; failing that, a SOL-equivalent cap is converted with
// the live SOL price, and only with the panel's typed-in price when the relay has never sent one.
const solRate = () => (liveSolUsd > 0 ? liveSolUsd : Number(cfg?.solPrice) > 0 ? Number(cfg.solPrice) : 101.95);
function mcText(mc, quote, mcUsd) {
  if (mcUsd > 0) return 'MC $' + compactNum(mcUsd);
  if (!(mc > 0)) return null;
  if (quote === 'USDC') return 'MC $' + compactNum(mc);
  if (!quote || quote === 'SOL') return 'MC $' + compactNum(mc * solRate());
  return 'MC ' + compactNum(mc) + ' ' + quote; // some other pair: no rate to convert with
}
// A coin quoted in dollars is talked about in dollars, even though the book behind it is kept in
// SOL-equivalent; everything else is SOL.
function signMoney(n, quote, kind) {
  if (quote === 'USDC') return `$${fmtNum(Math.abs(n))}`;
  if (kind === 'usd' && liveSolUsd > 0) return `$${fmtNum(Math.abs(n) * liveSolUsd)}`;
  return `${fmtNum(Math.abs(n))} SOL`;
}

// One open position, priced right now. Used both when choosing what to show and to keep a
// board that is already up refreshed while a newer position waits its turn.
function buildPositionContent(p) {
  const byMc = p.invSum > 0 && p.mc > 0 && p.cost > 0;
  const value = byMc ? p.mc * p.invSum : p.tokens * p.price;
  const pnl = value - p.cost;
  const pct = p.cost > 0 ? (pnl / p.cost) * 100 : 0;
  let open = 0;
  for (const q of positions.values()) if (q.tokens > 0 && q.live) open++;
  const cap = byMc || p.mcUsd > 0 ? mcText(p.mc, p.quote, p.mcUsd) : null;
  // where she bought it, the dollar cap, how many bags are open — whatever of those is known
  const foot = [VENUES[p.venue] || null, cap, open > 1 ? open + ' open' : null].filter(Boolean).join(' \u00b7 ') || null;
  return {
    id: 'pos:' + p.mint, pct,
    title: p.symbol ? '$' + p.symbol : p.mint.slice(0, 4) + '\u2026',
    amount: (pnl >= 0 ? '+' : '\u2212') + signMoney(pnl, p.quote, p.quoteKind),
    sub: `${pct >= 0 ? '+' : '\u2212'}${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`,
    foot,
    tone: pnl > 1e-9 ? 1 : pnl < -1e-9 ? -1 : 0,
  };
}
function positionContent(id) {
  if (!id || !id.startsWith('pos:')) return null;
  const p = positions.get(id.slice(4));
  return p && p.tokens > 0 ? buildPositionContent(p) : null;
}
function signContent() {
  if (cfg?.sign === false) return null;
  const hide = (c) => (c && c.id === signDismissedId ? null : c);
  const demo = demoContent();
  if (demo) return hide(demo);
  if (quiet('Board')) return null;
  if (scorecardUntil > T) return hide(scorecardContent());
  if (relayStatus !== 'ok') return null;
  if (signListMode) { const l = listContent(); if (l) return hide(l); signListMode = false; }
  const p = livePosition();
  if (p) return hide(buildPositionContent(p));
  if (sessionTrades > 0 && T - lastTradeAt < SESSION_SHOW) {
    return hide({
      id: 'session',
      title: 'SESSION',
      amount: (sessionPnl >= 0 ? '+' : '−') + signMoney(sessionPnl, sessionQuote),
      sub: `${sessionTrades} trade${sessionTrades === 1 ? '' : 's'}`,
      foot: null,
      tone: sessionPnl > 1e-9 ? 1 : sessionPnl < -1e-9 ? -1 : 0,
    });
  }
  return null;
}

// the board flipped over: every open bag, best to worst
let signListMode = false;
function listContent() {
  const rows = [];
  for (const p of positions.values()) if (p.tokens > 0 && p.live) { const c = buildPositionContent(p); rows.push({ sym: c.title, pnl: c.amount, pct: c.sub, tone: c.tone, mint: p.mint, n: c.pct }); }
  if (!rows.length) return null;
  rows.sort((a, b) => b.n - a.n);
  const lines = rows.slice(0, 6);
  const total = rows.reduce((s, r) => s + (r.tone === 0 ? 0 : 0), 0);
  return { id: 'list', title: 'OPEN BAGS', lines, amount: '', sub: rows.length > 6 ? `+${rows.length - 6} more` : '', foot: null, tone: lines[0].tone, text: lines.map((l) => l.sym + l.pnl + l.pct).join('|') };
}
// the flipped board, in the Aurora look whatever style the single board uses
function drawListBoard(g, c) {
  const x = 26, y = 16, w = SW - 52, h = BOARD_H - 32, r = 60;
  g.save(); g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 40; g.shadowOffsetY = 14;
  g.fillStyle = 'rgba(13,11,18,0.97)'; roundRect(g, x, y, w, h, r); g.fill(); g.restore();
  g.save(); roundRect(g, x, y, w, h, r); g.clip(); g.filter = 'blur(45px)';
  const bloom = (cx, cy, rad, col) => { const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2); };
  bloom(SW - 200, 30, 300, 'rgba(255,111,174,1)'); bloom(SW - 40, 130, 280, 'rgba(124,92,255,1)'); bloom(SW - 340, 150, 230, 'rgba(52,213,201,0.85)');
  g.filter = 'none'; g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 3; roundRect(g, x, y, w, h, r); g.stroke();
  sTxt(g, c.title, SW / 2, 88, '600 44px Rubik, "Segoe UI", system-ui, sans-serif', '#a79fbb', SW - 260, '8px');
  const n = c.lines.length, top = 150, rowH = Math.min(82, (BOARD_H - 190) / n);
  for (let i = 0; i < n; i++) {
    const l = c.lines[i], yy = top + rowH * i + rowH / 2;
    const acc = l.tone > 0 ? '#3fe0a5' : l.tone < 0 ? '#ff5c8a' : '#d9d3e8';
    if (i) { g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 2; g.beginPath(); g.moveTo(90, yy - rowH / 2); g.lineTo(SW - 90, yy - rowH / 2); g.stroke(); }
    g.textAlign = 'left';  sTxt(g, l.sym, 96, yy, '600 52px Rubik, "Segoe UI", system-ui, sans-serif', '#f1eef8', 330);
    g.textAlign = 'right'; sTxt(g, l.pnl, SW - 250, yy, '700 52px Outfit, "Segoe UI", system-ui, sans-serif', acc, 300);
    sTxt(g, l.pct, SW - 96, yy, '500 40px Rubik, "Segoe UI", system-ui, sans-serif', acc, 150);
  }
  g.textAlign = 'center';
  if (c.sub) sTxt(g, c.sub, SW / 2, BOARD_H - 46, '500 34px Rubik, "Segoe UI", system-ui, sans-serif', '#6f6785', SW - 130);
}
function ensureSign() {
  if (sign || !model) return sign;
  const canvas = document.createElement('canvas');
  canvas.width = SIGN_W; canvas.height = SIGN_H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const w = model.height * 0.46, h = w * (SIGN_H / SIGN_W);
  const geo = new THREE.PlaneGeometry(w, h);
  geo.translate(0, h / 2, 0); // pivot at the bottom of the handle: that is where her hand grips it
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, toneMapped: false }));
  mesh.renderOrder = 5;
  mesh.visible = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
  sign = { mesh, canvas, ctx: canvas.getContext('2d'), tex, phase: 'hidden', t: 0, id: null, side: -1, pose: 0, two: false, heldSince: -99, planeH: h, planeW: w, fitW: 0, text: '', drawnAt: -9, next: null, hover: false, sway: 0 };
  return sign;
}

function disposeSign() {
  if (!sign) return;
  scene.remove(sign.mesh);
  sign.mesh.geometry.dispose(); sign.mesh.material.dispose(); sign.tex.dispose();
  sign = null;
}

const SIGN_X = { cx: SIGN_W - 112, cy: 106, r: 54 }; // close badge, in texture pixels
const BOARD_H = 600;                                  // the board; the post fills the rest
const SIGN_TONE = {
  1:    { accent: '#3ddc84', text: '#7bf7b4', bg0: '#0d2c1e', bg1: '#04120a', glow: 'rgba(61,220,132,0.45)' },
  '-1': { accent: '#ff4d6a', text: '#ff96a8', bg0: '#2d0b14', bg1: '#12040a', glow: 'rgba(255,77,106,0.45)' },
  0:    { accent: '#9aa4cc', text: '#e2e6f6', bg0: '#1b1f2e', bg1: '#090b13', glow: 'rgba(154,164,204,0.35)' },
};
const compactNum = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return a >= 1 ? n.toFixed(1) : n.toFixed(3);
};

// ---- shared bits -----------------------------------------------------------
const SW = SIGN_W, SH = SIGN_H;
const SIGN_LATERAL = 0.11 / 0.46;   // board offset from the hand, as a fraction of board width
let POSTX = SW / 2;                 // where the post meets the board, in texture px
let SIGN_POST = true;               // a two-handed hold grips the board itself, so no post
function sTxt(g, s, x, y, font, fill, maxW, spacing) {
  g.font = font; g.fillStyle = fill;
  if (spacing != null) { try { g.letterSpacing = spacing; } catch {} }
  g.fillText(s, x, y, maxW);
  if (spacing != null) { try { g.letterSpacing = '0px'; } catch {} }
}
function postWood(g) {
  if (!SIGN_POST) return;
  const x = POSTX, w = 78, top = BOARD_H - 26;
  const grd = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  grd.addColorStop(0, '#6d4a2c'); grd.addColorStop(0.32, '#a9764a'); grd.addColorStop(0.62, '#8d5f39'); grd.addColorStop(1, '#5d3d23');
  g.fillStyle = grd; roundRect(g, x - w / 2, top, w, SH - top - 6, 14); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.30)'; g.lineWidth = 3;
  for (const dx of [-13, 16]) { g.beginPath(); g.moveTo(x + dx, top + 40); g.lineTo(x + dx + 4, SH - 26); g.stroke(); }
}
function postMetal(g) {
  if (!SIGN_POST) return;
  const x = POSTX, w = 66, top = BOARD_H - 26;
  const grd = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  grd.addColorStop(0, '#5a6070'); grd.addColorStop(0.35, '#c9d2e0'); grd.addColorStop(0.6, '#8d95a6'); grd.addColorStop(1, '#4b505d');
  g.fillStyle = grd; roundRect(g, x - w / 2, top, w, SH - top - 6, 10); g.fill();
}
function postDark(g) {
  if (!SIGN_POST) return;
  const x = POSTX, w = 58, top = BOARD_H - 26;
  g.fillStyle = '#1b1d26'; roundRect(g, x - w / 2, top, w, SH - top - 6, 10); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 3; roundRect(g, x - w / 2, top, w, SH - top - 6, 10); g.stroke();
}
// a rounded pill behind the percentage; returns nothing
function pill(g, txt, y, font, fillStyle, strokeStyle, textColor) {
  g.font = font;
  const pw = Math.min(SW - 180, g.measureText(txt).width + 104), ph = 108;
  const px = SW / 2 - pw / 2, py = y - ph / 2;
  if (fillStyle) { g.fillStyle = fillStyle; roundRect(g, px, py, pw, ph, ph / 2); g.fill(); }
  if (strokeStyle) { g.strokeStyle = strokeStyle; g.lineWidth = 3; roundRect(g, px, py, pw, ph, ph / 2); g.stroke(); }
  g.fillStyle = textColor; g.fillText(txt, SW / 2, y, pw - 44);
}
function gridOut(g, step, w) { // punch a pixel grid out of what is already drawn
  g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
  for (let x = 0; x < SW; x += step) g.fillRect(x, 0, w, BOARD_H);
  for (let y = 0; y < BOARD_H; y += step) g.fillRect(0, y, SW, w);
  g.restore();
}

// ---- the ten looks ---------------------------------------------------------
const SIGN_STYLES = [
{ key: 'neon', label: 'Neon glass', draw(g, c, t) {
  postWood(g);
  g.save(); g.shadowColor = t.glow; g.shadowBlur = 46; g.shadowOffsetY = 10;
  g.fillStyle = t.accent; roundRect(g, 26, 16, SW - 52, BOARD_H - 32, 48); g.fill(); g.restore();
  const p = g.createLinearGradient(0, 26, 0, BOARD_H - 26);
  p.addColorStop(0, t.bg0); p.addColorStop(1, t.bg1);
  g.fillStyle = p; roundRect(g, 36, 26, SW - 72, BOARD_H - 52, 40); g.fill();
  const sh = g.createLinearGradient(0, 26, 0, 250);
  sh.addColorStop(0, 'rgba(255,255,255,0.10)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sh; roundRect(g, 36, 26, SW - 72, 224, 40); g.fill();
  sTxt(g, c.title, SW / 2, 116, '700 92px "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.92)', SW - 290, '3px');
  g.save(); g.shadowColor = t.glow; g.shadowBlur = 26;
  sTxt(g, c.amount, SW / 2, 292, '800 152px "Segoe UI", system-ui, sans-serif', t.text, SW - 96); g.restore();
  pill(g, c.sub, 424, '700 76px "Segoe UI", system-ui, sans-serif', t.accent + '2e', t.accent + '88', t.accent);
  if (c.foot) sTxt(g, c.foot, SW / 2, 538, '600 58px "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.42)', SW - 130);
} },

{ key: 'chalk', label: 'Chalkboard', draw(g, c, t) {
  postWood(g);
  g.fillStyle = '#7a5330'; roundRect(g, 18, 12, SW - 36, BOARD_H - 24, 26); g.fill();
  g.fillStyle = '#2b332e'; roundRect(g, 44, 38, SW - 88, BOARD_H - 76, 14); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2;
  for (let i = 0; i < 22; i++) { const y = 50 + i * 24; g.beginPath(); g.moveTo(60, y); g.lineTo(SW - 60, y + (i % 3) * 2); g.stroke(); }
  const ink = c.tone > 0 ? '#a9f7c4' : c.tone < 0 ? '#ffb3bf' : '#f2efe4';
  sTxt(g, c.title, SW / 2, 122, '700 88px "Comic Sans MS", "Segoe UI", sans-serif', '#f6f2e6', SW - 290, '2px');
  sTxt(g, c.amount, SW / 2, 296, '700 146px "Comic Sans MS", "Segoe UI", sans-serif', ink, SW - 96);
  sTxt(g, c.sub, SW / 2, 424, '700 78px "Comic Sans MS", "Segoe UI", sans-serif', ink, SW - 200);
  if (c.foot) sTxt(g, c.foot, SW / 2, 528, '600 54px "Comic Sans MS", "Segoe UI", sans-serif', 'rgba(246,242,230,0.5)', SW - 130);
} },

{ key: 'white', label: 'Whiteboard', draw(g, c, t) {
  postMetal(g);
  g.fillStyle = '#c8ced8'; roundRect(g, 20, 14, SW - 40, BOARD_H - 28, 22); g.fill();
  g.fillStyle = '#f7f9fc'; roundRect(g, 34, 28, SW - 68, BOARD_H - 56, 14); g.fill();
  const ink = c.tone > 0 ? '#11a06a' : c.tone < 0 ? '#d32b45' : '#2b3346';
  sTxt(g, c.title, SW / 2, 118, '700 90px "Segoe UI", system-ui, sans-serif', '#1d2430', SW - 290, '2px');
  g.fillStyle = ink + '22'; roundRect(g, 70, 208, SW - 140, 8, 4); g.fill();
  sTxt(g, c.amount, SW / 2, 300, '800 150px "Segoe UI", system-ui, sans-serif', ink, SW - 96);
  pill(g, c.sub, 428, '700 74px "Segoe UI", system-ui, sans-serif', ink + '1c', ink + '66', ink);
  if (c.foot) sTxt(g, c.foot, SW / 2, 536, '600 56px "Segoe UI", system-ui, sans-serif', '#7b8698', SW - 130);
} },

{ key: 'terminal', label: 'Terminal', draw(g, c, t) {
  postDark(g);
  g.fillStyle = '#05070a'; roundRect(g, 22, 16, SW - 44, BOARD_H - 32, 12); g.fill();
  const ink = c.tone > 0 ? '#2bff9a' : c.tone < 0 ? '#ff4f6d' : '#9fe8ff';
  g.strokeStyle = ink + '77'; g.lineWidth = 4; roundRect(g, 22, 16, SW - 44, BOARD_H - 32, 12); g.stroke();
  g.textAlign = 'left';
  sTxt(g, '> ' + c.title, 74, 118, '700 78px Consolas, "Courier New", monospace', ink, SW - 200);
  sTxt(g, c.amount, 74, 292, '700 134px Consolas, "Courier New", monospace', ink, SW - 150);
  sTxt(g, '[ ' + c.sub + ' ]', 74, 424, '700 76px Consolas, "Courier New", monospace', ink + 'cc', SW - 150);
  if (c.foot) sTxt(g, c.foot, 74, 530, '400 52px Consolas, "Courier New", monospace', ink + '77', SW - 150);
  g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 16; y < BOARD_H - 16; y += 8) g.fillRect(22, y, SW - 44, 3);
} },

{ key: 'paper', label: 'Paper placard', draw(g, c, t) {
  postWood(g);
  g.save(); g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 26; g.shadowOffsetY = 8;
  g.fillStyle = '#f3e8d2'; roundRect(g, 26, 18, SW - 52, BOARD_H - 36, 10); g.fill(); g.restore();
  g.fillStyle = 'rgba(140,110,70,0.07)';
  for (let i = 0; i < 90; i++) g.fillRect(30 + Math.random() * (SW - 60), 22 + Math.random() * (BOARD_H - 44), 3, 3);
  g.strokeStyle = 'rgba(90,70,45,0.35)'; g.lineWidth = 3; roundRect(g, 48, 40, SW - 96, BOARD_H - 80, 6); g.stroke();
  const ink = c.tone > 0 ? '#1d7a4c' : c.tone < 0 ? '#b02a37' : '#3b3327';
  sTxt(g, c.title, SW / 2, 120, '700 88px Georgia, "Times New Roman", serif', '#3b3327', SW - 290, '4px');
  sTxt(g, c.amount, SW / 2, 296, '700 146px Georgia, "Times New Roman", serif', ink, SW - 96);
  sTxt(g, c.sub, SW / 2, 424, '700 74px Georgia, serif', ink, SW - 200);
  if (c.foot) sTxt(g, c.foot, SW / 2, 530, '400 54px Georgia, serif', 'rgba(59,51,39,0.55)', SW - 130);
  g.fillStyle = 'rgba(226,214,180,0.85)';
  for (const [x, y, r] of [[70, 34, -0.4], [SW - 190, 28, 0.35]]) { g.save(); g.translate(x, y); g.rotate(r); g.fillRect(0, 0, 150, 44); g.restore(); }
} },

{ key: 'tube', label: 'Neon tube', draw(g, c, t) {
  postDark(g);
  g.fillStyle = 'rgba(6,8,14,0.78)'; roundRect(g, 30, 20, SW - 60, BOARD_H - 40, 56); g.fill();
  g.save(); g.shadowColor = t.accent; g.shadowBlur = 40;
  g.strokeStyle = t.accent; g.lineWidth = 10; roundRect(g, 30, 20, SW - 60, BOARD_H - 40, 56); g.stroke();
  g.shadowBlur = 22; g.strokeStyle = '#ffffff'; g.lineWidth = 3; roundRect(g, 30, 20, SW - 60, BOARD_H - 40, 56); g.stroke(); g.restore();
  g.save(); g.shadowColor = t.accent; g.shadowBlur = 34;
  sTxt(g, c.title, SW / 2, 120, '700 86px "Segoe UI", system-ui, sans-serif', '#ffffff', SW - 290, '6px');
  g.shadowBlur = 44;
  sTxt(g, c.amount, SW / 2, 296, '800 150px "Segoe UI", system-ui, sans-serif', t.accent, SW - 110);
  g.shadowBlur = 26;
  sTxt(g, c.sub, SW / 2, 426, '700 76px "Segoe UI", system-ui, sans-serif', '#ffffff', SW - 200);
  g.restore();
  if (c.foot) sTxt(g, c.foot, SW / 2, 534, '600 54px "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.45)', SW - 130);
} },

{ key: 'metal', label: 'Metal plate', draw(g, c, t) {
  postMetal(g);
  const p = g.createLinearGradient(0, 16, 0, BOARD_H - 16);
  p.addColorStop(0, '#b9c2d0'); p.addColorStop(0.45, '#8e97a6'); p.addColorStop(0.5, '#7d8797'); p.addColorStop(1, '#aeb7c6');
  g.fillStyle = p; roundRect(g, 24, 16, SW - 48, BOARD_H - 32, 20); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
  for (let y = 20; y < BOARD_H - 20; y += 5) { g.beginPath(); g.moveTo(28, y); g.lineTo(SW - 28, y); g.stroke(); }
  g.strokeStyle = 'rgba(30,36,46,0.55)'; g.lineWidth = 5; roundRect(g, 44, 36, SW - 88, BOARD_H - 72, 12); g.stroke();
  for (const [x, y] of [[76, 68], [SW - 76, 68], [76, BOARD_H - 68], [SW - 76, BOARD_H - 68]]) {
    g.fillStyle = '#6f7885'; g.beginPath(); g.arc(x, y, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(x - 4, y - 4, 6, 0, Math.PI * 2); g.fill();
  }
  const ink = c.tone > 0 ? '#0d5c3a' : c.tone < 0 ? '#7d1626' : '#242a35';
  g.save(); g.shadowColor = 'rgba(255,255,255,0.6)'; g.shadowOffsetY = 2;
  sTxt(g, c.title, SW / 2, 124, '700 86px "Segoe UI", system-ui, sans-serif', '#2b313c', SW - 290, '5px');
  sTxt(g, c.amount, SW / 2, 300, '800 146px "Segoe UI", system-ui, sans-serif', ink, SW - 110);
  sTxt(g, c.sub, SW / 2, 428, '700 72px "Segoe UI", system-ui, sans-serif', ink, SW - 200);
  if (c.foot) sTxt(g, c.foot, SW / 2, 532, '600 52px "Segoe UI", system-ui, sans-serif', 'rgba(40,46,58,0.6)', SW - 130);
  g.restore();
} },

{ key: 'led', label: 'LED matrix', draw(g, c, t) {
  postDark(g);
  g.fillStyle = '#07090c'; roundRect(g, 22, 16, SW - 44, BOARD_H - 32, 16); g.fill();
  const ink = c.tone > 0 ? '#39ff88' : c.tone < 0 ? '#ff3b5c' : '#ffb43b';
  g.save();
  g.beginPath(); roundRect(g, 30, 24, SW - 60, BOARD_H - 48, 12); g.clip();
  g.save(); g.shadowColor = ink; g.shadowBlur = 18;
  sTxt(g, c.title, SW / 2, 118, '700 84px "Segoe UI", system-ui, sans-serif', ink, SW - 290, '4px');
  sTxt(g, c.amount, SW / 2, 296, '800 146px "Segoe UI", system-ui, sans-serif', ink, SW - 110);
  sTxt(g, c.sub, SW / 2, 426, '700 74px "Segoe UI", system-ui, sans-serif', ink, SW - 200);
  if (c.foot) sTxt(g, c.foot, SW / 2, 532, '600 52px "Segoe UI", system-ui, sans-serif', ink + '99', SW - 130);
  g.restore();
  gridOut(g, 8, 1.5);
  g.restore();
  g.strokeStyle = '#232833'; g.lineWidth = 6; roundRect(g, 22, 16, SW - 44, BOARD_H - 32, 16); g.stroke();
} },

{ key: 'kawaii', label: 'Kawaii pastel', draw(g, c, t) {
  postWood(g);
  const acc = c.tone > 0 ? '#57d6a3' : c.tone < 0 ? '#ff8fb1' : '#b6a8ff';
  g.save(); g.shadowColor = 'rgba(0,0,0,0.18)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillStyle = '#fff1f7'; roundRect(g, 26, 16, SW - 52, BOARD_H - 32, 62); g.fill(); g.restore();
  g.strokeStyle = acc; g.lineWidth = 12; roundRect(g, 26, 16, SW - 52, BOARD_H - 32, 62); g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.setLineDash([16, 16]);
  roundRect(g, 54, 44, SW - 108, BOARD_H - 88, 46); g.stroke(); g.setLineDash([]);
  for (const [x, y, r] of [[92, 88, 16], [SW - 92, 88, 16], [92, BOARD_H - 88, 13], [SW - 92, BOARD_H - 88, 13]]) {
    g.fillStyle = acc; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  sTxt(g, c.title, SW / 2, 124, '700 86px "Segoe UI", system-ui, sans-serif', '#6b5570', SW - 290, '3px');
  sTxt(g, c.amount, SW / 2, 300, '800 148px "Segoe UI", system-ui, sans-serif', acc, SW - 110);
  pill(g, c.sub, 430, '700 74px "Segoe UI", system-ui, sans-serif', acc + '2a', acc, acc);
  if (c.foot) sTxt(g, c.foot, SW / 2, 536, '600 54px "Segoe UI", system-ui, sans-serif', 'rgba(107,85,112,0.55)', SW - 130);
} },

{ key: 'holo', label: 'Holographic', draw(g, c, t) {
  postMetal(g);
  const hg = g.createLinearGradient(26, 16, SW - 26, BOARD_H - 16);
  hg.addColorStop(0, '#6a3bd6'); hg.addColorStop(0.28, '#2f9bf0'); hg.addColorStop(0.52, '#37e0c4');
  hg.addColorStop(0.74, '#f06ad0'); hg.addColorStop(1, '#ffc46b');
  g.save(); g.shadowColor = 'rgba(120,90,255,0.5)'; g.shadowBlur = 40;
  g.fillStyle = hg; roundRect(g, 26, 16, SW - 52, BOARD_H - 32, 44); g.fill(); g.restore();
  g.fillStyle = 'rgba(8,10,20,0.76)'; roundRect(g, 40, 30, SW - 80, BOARD_H - 60, 36); g.fill();
  const sh = g.createLinearGradient(40, 30, SW - 40, 300);
  sh.addColorStop(0, 'rgba(255,255,255,0.18)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.04)'); sh.addColorStop(1, 'rgba(255,255,255,0.14)');
  g.fillStyle = sh; roundRect(g, 40, 30, SW - 80, BOARD_H - 60, 36); g.fill();
  sTxt(g, c.title, SW / 2, 118, '700 88px "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.95)', SW - 290, '4px');
  g.save(); g.shadowColor = t.glow; g.shadowBlur = 28;
  sTxt(g, c.amount, SW / 2, 294, '800 150px "Segoe UI", system-ui, sans-serif', t.text, SW - 110); g.restore();
  pill(g, c.sub, 426, '700 74px "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.12)', 'rgba(255,255,255,0.45)', '#ffffff');
  if (c.foot) sTxt(g, c.foot, SW / 2, 534, '600 54px "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.5)', SW - 130);
} },

// Her panel's twin, and the default: near-black glass with a soft pink / violet / teal bloom in the
// top corner and the figure in a white-to-tone gradient. A loss swaps the mint bloom for rose.
{ key: 'aurora', label: 'Aurora glass', draw(g, c, t) {
  const acc = c.tone > 0 ? '#3fe0a5' : c.tone < 0 ? '#ff5c8a' : '#a79fbb';
  const x = 26, y = 16, w = SW - 52, h = BOARD_H - 32, r = 60;
  g.save(); g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 40; g.shadowOffsetY = 14;
  g.fillStyle = 'rgba(13,11,18,0.97)'; roundRect(g, x, y, w, h, r); g.fill(); g.restore();
  g.save();
  roundRect(g, x, y, w, h, r); g.clip();
  g.filter = 'blur(45px)';
  const bloom = (cx, cy, rad, col) => {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  };
  bloom(SW - 200, 30, 300, c.tone < 0 ? 'rgba(255,92,138,1)' : 'rgba(255,111,174,1)');
  bloom(SW - 40, 130, 280, 'rgba(124,92,255,1)');
  if (c.tone >= 0) bloom(SW - 340, 150, 230, 'rgba(52,213,201,0.85)');
  g.filter = 'none';
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 3; roundRect(g, x, y, w, h, r); g.stroke();
  sTxt(g, c.title.toUpperCase(), SW / 2, 116, '600 48px Rubik, "Segoe UI", system-ui, sans-serif', '#a79fbb', SW - 260, '8px');
  const font = '700 176px Outfit, "Segoe UI", system-ui, sans-serif';
  g.font = font;
  const tw = Math.min(SW - 110, g.measureText(c.amount).width);
  const grad = g.createLinearGradient(SW / 2 - tw / 2, 0, SW / 2 + tw / 2, 0);
  grad.addColorStop(0.1, '#ffffff'); grad.addColorStop(0.9, acc);
  sTxt(g, c.amount, SW / 2, 296, font, grad, SW - 110);
  pill(g, c.sub, 428, '500 54px Rubik, "Segoe UI", system-ui, sans-serif', 'rgba(255,255,255,0.07)', 'rgba(255,255,255,0.14)', acc);
  if (c.foot) sTxt(g, c.foot.toUpperCase(), SW / 2, 538, '500 42px Rubik, "Segoe UI", system-ui, sans-serif', '#d9d3e8', SW - 130, '4px');
} },
];
// Canvas text does not pull a @font-face in on its own, so the board's typefaces are requested up
// front and the board is redrawn once they land — otherwise it would keep the fallback face until
// its text next changed.
if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load('700 100px Outfit'), document.fonts.load('500 40px Rubik')])
    .then(() => { if (sign) sign.text = ''; }).catch(() => {});
}

function signStyle() {
  const i = Number(cfg?.signStyle);
  return SIGN_STYLES[Number.isFinite(i) && i >= 0 && i < SIGN_STYLES.length ? i : 0];
}

function drawSign(c) {
  const g = sign.ctx;
  SIGN_POST = !sign.two;
  POSTX = SW * (0.5 - sign.side * SIGN_LATERAL);
  g.clearRect(0, 0, SW, SH);
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round';
  if (c.lines) drawListBoard(g, c); else signStyle().draw(g, c, SIGN_TONE[String(c.tone)] || SIGN_TONE[0]);
  if (sign.hover) {
    // the badges along the top edge: close, and — when it makes sense — flip, copy, open
    for (const b of signBadges(c)) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 12;
      g.fillStyle = 'rgba(12,14,20,0.86)';
      g.beginPath(); g.arc(b.cx, b.cy, b.r, 0, Math.PI * 2); g.fill();
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 3;
      g.beginPath(); g.arc(b.cx, b.cy, b.r, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round'; g.fillStyle = '#ffffff';
      const d = b.r * 0.40, cx = b.cx, cy = b.cy;
      g.beginPath();
      if (b.key === 'close') { g.moveTo(cx - d, cy - d); g.lineTo(cx + d, cy + d); g.moveTo(cx + d, cy - d); g.lineTo(cx - d, cy + d); g.stroke(); }
      else if (b.key === 'list') { for (const k of [-1, 0, 1]) { g.moveTo(cx - d, cy + k * d * 0.85); g.lineTo(cx + d, cy + k * d * 0.85); } g.stroke(); }
      else if (b.key === 'copy') { g.lineWidth = 6; roundRect(g, cx - d, cy - d * 0.55, d * 1.4, d * 1.4, 6); g.stroke(); g.beginPath(); roundRect(g, cx - d * 0.4, cy - d * 1.1, d * 1.4, d * 1.4, 6); g.stroke(); }
      else if (b.key === 'open') { g.moveTo(cx - d, cy + d); g.lineTo(cx + d, cy - d); g.moveTo(cx - d * 0.1, cy - d); g.lineTo(cx + d, cy - d); g.lineTo(cx + d, cy + d * 0.1); g.stroke(); }
    }
  }
  sign.tex.needsUpdate = true;
}
// which badges the board offers for what it is showing, in texture px
function signBadges(c) {
  const out = [{ key: 'close', cx: SIGN_X.cx, cy: SIGN_X.cy, r: SIGN_X.r }];
  const hasMint = c && c.id && c.id.startsWith('pos:');
  const step = 128;
  let i = 1;
  if (hasMint) { out.push({ key: 'open', cx: SIGN_X.cx - step * i++, cy: SIGN_X.cy, r: SIGN_X.r }); out.push({ key: 'copy', cx: SIGN_X.cx - step * i++, cy: SIGN_X.cy, r: SIGN_X.r }); }
  if (c && (hasMint || c.id === 'list')) out.push({ key: 'list', cx: SIGN_X.cx - step * i++, cy: SIGN_X.cy, r: SIGN_X.r });
  return out;
}
function signBadgeAction(key) {
  const c = signContent();
  if (key === 'close') return dismissSign();
  if (key === 'list') { signListMode = !signListMode; if (sign) sign.text = ''; return true; }
  const mint = c && c.id && c.id.startsWith('pos:') ? c.id.slice(4) : null;
  if (!mint) return false;
  if (key === 'copy') { navigator.clipboard.writeText(mint).then(() => say('Copied~', 2)).catch(() => say("Couldn't copy…", 2)); return true; }
  if (key === 'open') {
    const w = cfg?.openWith || 'axiom';
    const url = w === 'pump' ? `https://pump.fun/coin/${mint}` : w === 'dexscreener' ? `https://dexscreener.com/solana/${mint}` : `https://axiom.trade/t/${mint}`;
    bridge.openExternal(url); say('Opening~', 2); return true;
  }
  return false;
}

// the sign is only held while she is upright and calm; otherwise she stashes it
const SIGN_STATES = new Set(['idle', 'walk', 'sit', 'wave', 'notice', 'cheer', 'comfort', 'gasp', 'wince', 'guard']);
const SIGN_REACH = 0.42; // how far the board sticks out from her centre, in body heights
function signTwoHanded(want) {
  const m = cfg?.signHold;
  return m === 'two' ? true : m === 'one' ? false : Math.random() < 0.5;
}
function signSideChoice() {
  if (!model) return -1;
  const need = model.height * SIGN_REACH;
  if (pet.x - minX < need) return 1;   // hugging the left wall: hold it on her left instead
  if (maxX - pet.x < need) return -1;
  return -1;                            // her right by default
}
function signHoldable() {
  return model && pet.onGround && Math.abs(pet.theta) < 0.5 && SIGN_STATES.has(pet.state) && !pet.grab;
}

// It is now an actual capsule in the scene, parented to her root so it turns and tilts with her.
function updateSign(dt) {
  const want = signHoldable() ? signContent() : null;
  if (!want && !sign) return;
  ensureSign();
  const s = sign;
  s.t += dt;

  if (s.phase === 'hidden') {
    if (want) { s.next = want; s.phase = 'pulling'; s.t = 0; s.id = want.id; s.side = signSideChoice(); s.pose = Math.floor(Math.random() * HOLD_POSES.length); s.two = signTwoHanded(want); drawSign(want); s.text = want.id + want.amount + want.sub + (want.foot || ''); s.drawnAt = T; }
  } else if (s.phase === 'pulling') {
    if (!want) { s.phase = 'stashing'; s.t = 0; }
    else if (s.t >= SIGN_PULL) { s.phase = 'held'; s.t = 0; s.heldSince = T; }
  } else if (s.phase === 'held') {
    if (!want) { s.phase = 'stashing'; s.t = 0; }
    else if (want.id !== s.id && T - s.heldSince >= SIGN_MIN_HOLD) { s.next = want; s.phase = 'stashing'; s.t = 0; } // different token: swap signs
    else if (want.id !== s.id) {
      // a newer position arrived, but this board has not been up long enough to read yet:
      // keep showing this one, still correctly priced, until it has had its moment
      const cur = positionContent(s.id);
      if (cur) {
        const t2 = cur.id + cur.amount + cur.sub + (cur.foot || '') + (s.hover ? '#x' : '');
        if (t2 !== s.text && T - s.drawnAt > 0.08) { drawSign(cur); s.text = t2; s.drawnAt = T; }
      }
    }
    else {
      const text = want.id + want.amount + want.sub + (want.foot || '') + (want.text || '') + (s.hover ? '#x' : '');
      if (text !== s.text && T - s.drawnAt > 0.08) { drawSign(want); s.text = text; s.drawnAt = T; }
    }
  } else if (s.phase === 'stashing') {
    if (s.t >= SIGN_STASH) {
      if (want) { s.phase = 'pulling'; s.t = 0; s.id = want.id; s.side = signSideChoice(); s.pose = Math.floor(Math.random() * HOLD_POSES.length); s.two = signTwoHanded(want); drawSign(want); s.text = want.id + want.amount + want.sub + (want.foot || ''); s.drawnAt = T; }
      else { s.phase = 'hidden'; s.t = 0; s.id = null; s.mesh.visible = false; }
    }
  }

  // ---- scale: it grows as it comes out from behind her, shrinks as it goes back
  let k = 0;
  if (s.phase === 'pulling') k = smoothstep((s.t - 0.28) / 0.42);
  else if (s.phase === 'held') k = 1;
  else if (s.phase === 'stashing') k = 1 - smoothstep(s.t / SIGN_STASH);
  s.mesh.visible = k > 0.02;
  if (!s.mesh.visible) return;

  // ---- follow her right hand, billboard to the camera, roll with her body
  const arm = s.side < 0 ? 'right' : 'left';
  const grip = (side) => model.bones[side + 'MiddleProximal'] || model.bones[side + 'Hand'] || model.bones[side + 'LowerArm'];
  if (s.two) {
    const r = grip('right'), l = grip('left');
    if (!r || !l) { s.mesh.visible = false; return; }
    r.getWorldPosition(_sv); l.getWorldPosition(_sh);
    _sright.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const span = Math.abs(_sh.clone().sub(_sv).dot(_sright)); // apparent width of her grip
    _sv.add(_sh).multiplyScalar(0.5);            // centre of her grip
    const over = Math.max(1.0, 1.06 + 0.45 * ((cfg?.signSize ?? 1) - 1));
    const maxW = model.height * 0.95;
    const want = clamp(span * over, model.height * 0.22, maxW);
    s.fitW = s.fitW > 0 ? damp(s.fitW, want, 8, dt) : want;
  } else {
    const hand = grip(arm);
    if (!hand) { s.mesh.visible = false; return; }
    hand.getWorldPosition(_sv);
    _sv.x += s.side * model.height * 0.11;        // just clear of her torso
  }
  const halfBoard = model.height * 0.24;
  _sv.x = clamp(_sv.x, -W / 2 / ppu + halfBoard, W / 2 / ppu - halfBoard); // stay on screen
  // a hand-held board is never perfectly square to you: keep a small tilt, and let it lag as she moves
  s.sway = damp(s.sway, clamp(-pet.vx * 0.10, -0.22, 0.22), 5, dt);
  s.mesh.quaternion.copy(camera.quaternion);
  s.mesh.rotateZ(pet.theta * 0.6 + s.sway + (s.two ? 0 : s.side * 0.05) + Math.sin(T * 0.9) * 0.018);
  const scale = s.two ? k * (s.fitW / s.planeW) : k * (cfg?.signSize ?? 1);
  s.mesh.scale.setScalar(scale);
  // the mesh pivot is the foot of the post: drop it below her fist so the post passes through it
  _sup.set(0, 1, 0).applyQuaternion(s.mesh.quaternion);
  _sfwd.set(0, 0, 1).applyQuaternion(s.mesh.quaternion);
  s.mesh.position.copy(_sv)
    .addScaledVector(_sup, -(s.two ? 0.68 : 0.15) * s.planeH * scale)
    // one hand: behind her fist so the fingers wrap the post. Both hands: in front of her chest,
    // but behind her fingers, so they come over the front face at each side.
    .addScaledVector(_sfwd, model.height * -0.025);
}
const _sv = new THREE.Vector3(), _sb = new THREE.Vector3(), _sup = new THREE.Vector3(), _sfwd = new THREE.Vector3(), _sh = new THREE.Vector3(), _sright = new THREE.Vector3();
// where the board lands on screen, in CSS px
function signScreenBox() {
  if (!sign || !sign.mesh.visible || !model) return null;
  const g = sign.mesh.geometry.parameters;
  const box = { l: 1e9, r: -1e9, t: 1e9, b: -1e9 };
  for (const dx of [-g.width / 2, g.width / 2]) for (const dy of [0, g.height]) {
    _sb.set(dx, dy, 0).applyMatrix4(sign.mesh.matrixWorld).project(camera);
    const x = canvasLeft + (_sb.x + 1) / 2 * CS, y = canvasTop + (1 - _sb.y) / 2 * CS;
    box.l = Math.min(box.l, x); box.r = Math.max(box.r, x); box.t = Math.min(box.t, y); box.b = Math.max(box.b, y);
  }
  return box;
}
// screen rect of the close badge, or null when it is not showing
function signCloseAt() {
  const b = signBadgeAt('close');
  return b;
}
// screen circle of one badge, or null when the board is not up
function signBadgeAt(key) {
  if (!sign || !sign.mesh.visible || sign.phase !== 'held') return null;
  const box = signScreenBox();
  if (!box) return null;
  const c = signContent();
  const b = signBadges(c).find((x) => x.key === key);
  if (!b) return null;
  const w = box.r - box.l, h = box.b - box.t;
  return { x: box.l + (b.cx / SIGN_W) * w, y: box.t + (b.cy / SIGN_H) * h, r: Math.max(15, (b.r / SIGN_W) * w), key };
}
function signHitTest() {
  if (!cursor.seen) return { over: false, close: false, badge: null };
  const box = signScreenBox();
  if (!box || sign.phase !== 'held') return { over: false, close: false, badge: null };
  const over = cursor.sx >= box.l - 4 && cursor.sx <= box.r + 4 && cursor.sy >= box.t - 4 && cursor.sy <= box.b + 4;
  let badge = null;
  if (over) {
    const c = signContent();
    for (const b of signBadges(c)) { const p = signBadgeAt(b.key); if (p && Math.hypot(cursor.sx - p.x, cursor.sy - p.y) <= p.r + 3) { badge = b.key; break; } }
  }
  return { over, close: badge === 'close', badge };
}
function dismissSign() {
  if (!sign || sign.phase !== 'held') return false;
  signDismissedId = sign.id;
  sign.phase = 'stashing'; sign.t = 0; sign.hover = false;
  return true;
}
function signOnLeft() { return sign && sign.mesh.visible ? sign.mesh.position.x < pet.x : false; }

// arm pose: reach behind her back, then hold the sign up beside her
function signPose() {
  if (!sign || sign.phase === 'hidden') return;
  const s = sign;
  let reach = 0, hold = 0;
  if (s.phase === 'pulling') { reach = 1 - smoothstep(s.t / 0.45); hold = smoothstep((s.t - 0.25) / 0.45); }
  else if (s.phase === 'held') { hold = 1; }
  else if (s.phase === 'stashing') { hold = 1 - smoothstep(s.t / SIGN_STASH); reach = smoothstep(s.t / SIGN_STASH) * 0.8; }
  const A = s.side < 0 ? 'right' : 'left';
  const m = s.side < 0 ? 1 : -1; // mirror the y/z components for the other arm
  if (reach > 0.01) {
    mixPose(A + 'UpperArm', 0.55, -0.15 * m, -0.12 * m, reach);
    mixPose(A + 'LowerArm', 0, -0.95 * m, -0.45 * m, reach);
    addPose('spine', 0, -0.14 * reach * m, 0);
    addPose('chest', 0, -0.08 * reach * m, 0);
  }
  gripHand(A, Math.max(hold, reach * 0.7)); // she keeps hold of it while it comes out, too
  if (s.two) gripHand(A === 'right' ? 'left' : 'right', hold);
  if (hold > 0.01) {
    if (s.two) {
      // both arms: elbows in at her sides, forearms up and inward, the board resting on both fists
      const P2 = HOLD_TWO;
      for (const side of ['right', 'left']) {
        const k = side === 'right' ? 1 : -1;
        mixPose(side + 'UpperArm', P2.ua[0], P2.ua[1] * k, P2.ua[2] * k, hold);
        mixPose(side + 'LowerArm', P2.la[0], P2.la[1] * k, P2.la[2] * k, hold);
        mixPose(side + 'Hand', TWO_GRIP.roll, P2.hd[1] * k, P2.hd[2] * k, hold);
      }
      addPose('spine', 0.03 * hold, 0, 0);
    } else {
      const P = HOLD_POSES[s.pose] || HOLD_POSES[0];
      mixPose(A + 'UpperArm', P.ua[0], P.ua[1] * m, P.ua[2] * m, hold);
      mixPose(A + 'LowerArm', P.la[0], P.la[1] * m, P.la[2] * m, hold);
      mixPose(A + 'Hand', P.hd[0] + GRIP_TUNE.roll * m, P.hd[1] * m, P.hd[2] * m, hold);
      addPose('chest', 0, -0.05 * hold * m, 0);
      addPose('head', 0, 0.05 * hold * m, 0);
    }
  }
}

// ---------------------------------------------------------------- figure
// Bust size scales the bust bones about their base (the chest wall), which pushes the
// skin and clothing vertices they drive outward together. Bounce retunes the bust
// spring joints: softer springs swing wider, less drag keeps them jiggling longer.
// Skirt length scales the six skirt root bones vertically. The spring bones already
// react to every movement of her body, so no extra simulation is needed.
//
// Outfit, top/bottom style, cleavage and hair/eye colour are texture edits done on a
// canvas at load / when changed: recolouring works class by class (vest, shirt, collar,
// skirt, bow, hair, iris) keeping the painted shading; cut-outs use the alpha test so the
// skin mesh underneath shows (VRoid leaves that skin transparent, so it is filled with her
// sampled skin tone first); the bikini top is painted onto the skin.
const OUTFITS = {
  uniform:   { label: 'School uniform (original)' },
  blackgold: { label: 'Black & gold',  vest: [0.10, 0.10, 0.12], shirt: [1, 1, 1],          collar: [0.90, 0.72, 0.28], skirt: [0.10, 0.10, 0.12], bow: [0.95, 0.78, 0.25] },
  crimson:   { label: 'Crimson',       vest: [0.58, 0.07, 0.12], shirt: [1, 1, 1],          collar: [0.15, 0.10, 0.12], skirt: [0.48, 0.06, 0.10], bow: [0.12, 0.10, 0.12] },
  white:     { label: 'All white',     vest: [0.96, 0.96, 0.98], shirt: [1, 1, 1],          collar: [0.62, 0.76, 0.96], skirt: [0.96, 0.96, 0.98], bow: [0.55, 0.75, 0.95] },
  pink:      { label: 'Sakura pink',   vest: [0.96, 0.58, 0.72], shirt: [1, 1, 1],          collar: [1, 1, 1],          skirt: [0.92, 0.48, 0.64], bow: [1, 0.95, 0.97] },
  purple:    { label: '$YUI purple',   vest: [0.38, 0.12, 0.58], shirt: [0.96, 0.96, 1],    collar: [0.55, 1, 0.45],    skirt: [0.32, 0.09, 0.50], bow: [0.55, 1, 0.45] },
  black:     { label: 'All black',     vest: [0.08, 0.08, 0.09], shirt: [0.12, 0.12, 0.14], collar: [0.30, 0.30, 0.34], skirt: [0.08, 0.08, 0.09], bow: [0.55, 0.08, 0.12] },
  custom:    { label: 'Custom colours' },
};
const TOP_STYLES = { full: 'Full', sleeveless: 'Sleeveless', crop: 'Crop top', bikini: 'Bikini top' };
const BOTTOM_STYLES = { skirt: 'Skirt', bikini: 'Bikini bottom' };
// texture-space landmarks of the bundled model (2048 px textures)
const TOP_UV = { seamV: 705, seamL: 905, seamR: 1141, midU: 1023, vTop: 1000, vDeep: 1440, cropV: 1430, sleeveL: 660, sleeveR: 1310, sleeveV: 715 };
const SKIN_UV = { midU: 1024, creaseTop: 380, creaseBottom: 610, apexL: 932, apexR: 1116, apexV: 553, bandV: 645, neckV: 150, hipTop: 820, hipStrap: 935 };

const hex2rgb = (h, fb) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return fb; const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const rgb2css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
function outfitColors() {
  const o = OUTFITS[cfg?.outfit] ? cfg.outfit : 'uniform';
  if (o === 'custom') {
    const vest = hex2rgb(cfg.customVest, [0.1, 0.1, 0.12]), skirt = hex2rgb(cfg.customSkirt, vest), bow = hex2rgb(cfg.customBow, [0.95, 0.78, 0.25]);
    return { vest, shirt: [1, 1, 1], collar: bow, skirt, bow };
  }
  return OUTFITS[o];
}

let SPRING_TUNE = { k: 0.35, d: 0.030 }; // spring at 100% bounce: softer and barely damped
// A spring bone can never swing much further than the body that drives it, so softening it only
// makes the wobble last longer, not travel further. To actually get more movement we take the
// deflection the solver produced and scale it up about its rest pose.
let BOUNCE_GAIN = 1.0;                    // extra deflection at 100% bounce (1.0 = twice as far)
const _bq = new THREE.Quaternion(), _bd = new THREE.Quaternion(), _bi = new THREE.Quaternion(), _bp = new THREE.Quaternion();
const _bax = new THREE.Vector3();
let BOUNCE_MAX = 0.6; // hard stop on the amplified swing (rad): past this her chest pushes through her top
function amplifyBust(dt) {
  if (!model || !model.bust || !model.bust.avg) return;
  const extra = BOUNCE_GAIN * clamp(cfg?.jiggle ?? FIG.jiggle, 0, 1);
  const nodes = model.bust.nodes, avg = model.bust.avg;
  const k = 1 - Math.exp(-3.0 * dt); // how fast the baseline follows her settled posture
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!avg[i]) { avg[i] = n.quaternion.clone(); continue; }
    const base = avg[i];
    _bp.copy(n.quaternion);                       // what the solver produced, before we touch it
    if (extra > 0.001) {
      _bd.copy(base).invert().multiply(_bp).normalize(); // the fast part: deviation from her settled pose
      const w = clamp(_bd.w, -1, 1), sn = w < 0 ? -1 : 1, sh = Math.sqrt(Math.max(0, 1 - w * w));
      if (sh > 1e-5) {
        _bax.set(_bd.x, _bd.y, _bd.z).multiplyScalar(sn / sh);
        const ang = Math.min(2 * Math.acos(Math.abs(w)) * (1 + extra), BOUNCE_MAX);
        _bi.setFromAxisAngle(_bax, ang);
        _bq.copy(base).multiply(_bi);
        n.quaternion.copy(_bq);
        // the spring solver leaves these nodes with matrixAutoUpdate off, so a new rotation is
        // ignored unless the matrix is recomposed by hand, children included
        n.updateMatrix();
        n.updateMatrixWorld(true);
      }
    }
    base.slerp(_bp, k);                           // follow the solver, not our amplified result
  }
}

// 0.5 means "as the model's author built her"; either side of it is a deliberate change, so the
// sliders read as -100%..+100% rather than as an absolute the user has to guess the neutral of.
const prop = (v, lo, hi) => {
  // Coerced deliberately: a non-numeric setting here would put NaN into a bone scale and collapse
  // her skeleton to nothing, which is a very confusing way to find out about a bad value.
  const n = Number(v);
  const x = clamp(Number.isFinite(n) ? n : 0.5, 0, 1);
  return x < 0.5 ? lerp(lo, 1, x * 2) : lerp(1, hi, (x - 0.5) * 2);
};

function applyFigure() {
  if (!model || !model.bust) return;
  const size = clamp(cfg?.bust ?? FIG.bust, 0, 1), bounce = clamp(cfg?.jiggle ?? FIG.jiggle, 0, 1);

  const B = model.rawBones || {};
  const xz = (bone, f) => { if (bone) { bone.scale.x = f; bone.scale.z = f; } };

  const hipsF = prop(cfg?.hips ?? FIG.hips, 0.85, 1.28);
  const waistF = prop(cfg?.waist ?? FIG.waist, 0.70, 1.36);
  const thighF = prop(cfg?.thighs ?? FIG.thighs, 0.85, 1.45);
  const headF = prop(cfg?.headSize ?? FIG.headSize, 0.88, 1.22);

  // A bone scales everything hanging off it, so each change is undone again further up or down the
  // chain to keep it where it belongs. The waist is deliberately carried through the ribcage as
  // well as the spine: scaling the spine alone moves so little flesh that the slider looks dead.
  xz(B.hips, hipsF);
  xz(B.spine, waistF / hipsF);
  xz(B.chest, 1);
  xz(B.upperChest || B.chest, 1 / waistF);          // the ribcage keeps its own width
  for (const side of ['left', 'right']) {
    xz(B[side + 'UpperLeg'], thighF / hipsF);
    xz(B[side + 'LowerLeg'], 1 / thighF);           // calves keep their own shape
  }
  if (B.head) B.head.scale.setScalar(headF);        // hair is parented to it and follows, as it should

  // The bust is set last so it can be held clear of whatever the waist did to its parent.
  const sBust = (1 + 2.8 * size) * (model.bustUnderChest ? 1 / waistF : 1);
  for (const n of model.bust.nodes) n.scale.setScalar(sBust);
  for (const { j, stiffness, drag } of model.bust.joints) {
    // softer spring = wider swing, less drag = keeps jiggling; 0% is close to rigid
    j.settings.stiffness = lerp(Math.max(stiffness, 1.2), SPRING_TUNE.k, bounce);
    j.settings.dragForce = lerp(0.3, SPRING_TUNE.d, bounce);
  }

  const skirtLen = clamp(cfg?.skirtLen ?? FIG.skirtLen, 0.3, 1);
  for (const n of model.skirt || []) n.scale.y = skirtLen;
  const F = model.figure || {};
  const top = TOP_STYLES[cfg?.topStyle] ? cfg.topStyle : 'full';
  const bottom = BOTTOM_STYLES[cfg?.bottomStyle] ? cfg.bottomStyle : 'skirt';
  const vis = (k, v) => { if (F[k]) for (const f of F[k].list) f.m.visible = v; };
  vis('tops', top !== 'bikini');
  vis('skirt', bottom !== 'bikini');
  vis('bow', (cfg?.bow ?? FIG.bow) && top !== 'bikini');
  springResetPending = 2;                           // the springs cached rest lengths at the old scale
}

// Groups the model's materials by what part of the outfit they paint, so the outfit editor can
// find them by role rather than by the exporter's naming.
function figureMaterials(vrm) {
  const found = {};
  const add = (key, m) => {
    if (!found[key]) found[key] = { list: [] };
    if (found[key].list.some((x) => x.m === m)) return;   // shared by several meshes: one record
    found[key].list.push({
      m,
      map: m.map,
      shade: m.shadeMultiplyTexture && m.shadeMultiplyTexture !== m.map ? m.shadeMultiplyTexture : null,
      alphaTest: m.alphaTest,
      generated: [],
    });
    if (!found[key].m) found[key].m = m;
  };
  vrm.scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || !m.map) continue;
      if (m.isOutline) continue;                            // outline clones follow their surface (syncOutlines)
      const n = m.name || '';
      const key = /Face.*SKIN/i.test(n) ? 'face'
        : /Tops/i.test(n) ? 'tops'
        : /Bottoms/i.test(n) ? 'skirt'
        : /AccessoryNeck/i.test(n) ? 'bow'
        : /Body.*SKIN/i.test(n) ? 'skin'
        : /HAIR/i.test(n) ? 'hair'
        : /EyeIris/i.test(n) ? 'iris'
        : null;
      if (key) add(key, m);
    }
  });
  return found;
}

// Repaints a texture by lightness rather than by hue: each pixel is classified into a part of the
// garment, then tinted to the chosen colour while keeping its original shading, so folds and
// creases survive a recolour.
function recolorPixels(img, classify, colors) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const L = (max + min) / 2;
    const S = max === min ? 0 : (max - min) / (1 - Math.abs(2 * L - 1));
    const c = classify(L, S);
    if (!c) continue;
    const t = colors[c.name];
    if (!t) continue;
    const k = Math.min(1.6, L / c.ref);   // how light this pixel was, relative to the part's base
    d[i] = Math.min(255, t[0] * k * 255);
    d[i + 1] = Math.min(255, t[1] * k * 255);
    d[i + 2] = Math.min(255, t[2] * k * 255);
  }
}

// Which band of lightness belongs to which piece, and the reference lightness of each piece.
const CLASSIFY = {
  tops: (L, S) => (L < 0.33 ? { name: 'vest', ref: 0.17 }
    : L >= 0.62 ? { name: 'shirt', ref: 0.86 }
    : S > 0.3 ? { name: 'collar', ref: 0.5 }
    : null),
  skirt: (L) => (L < 0.5 ? { name: 'skirt', ref: 0.2 } : null),
  bow: () => ({ name: 'bow', ref: 0.55 }),
  hair: () => ({ name: 'hair', ref: 0.28 }),
  iris: () => ({ name: 'iris', ref: 0.4 }),
};

// A canvas texture that keeps every sampling setting of the one it replaces.
function makeTexture(src, canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = src.flipY;
  t.colorSpace = src.colorSpace;
  t.wrapS = src.wrapS;
  t.wrapT = src.wrapT;
  t.minFilter = src.minFilter;
  t.magFilter = src.magFilter;
  t.anisotropy = src.anisotropy;
  t.needsUpdate = true;
  return t;
}

// VRoid leaves the skin under the clothes transparent or black, because nothing was ever meant to
// see it. Cutting a neckline exposes exactly that, so the empty pixels are filled with the average
// skin tone sampled from a patch of her body that is always painted.
// `inside(u, v)` (2048-space texture px) limits the fill to where it returns true; without it the
// whole sheet is filled. Skin left transparent under the top cannot show through it when her chest
// bounces, so the less of it is filled the better.
function fillSkin(g, w, h, sx, sy, inside) {
  const id = g.getImageData(0, 0, w, h), d = id.data;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = Math.round(90 * sy); y < Math.round(215 * sy); y += 2) {
    for (let x = Math.round(900 * sx); x < Math.round(1150 * sx); x += 2) {
      const i = (y * w + x) * 4;
      const L = (Math.max(d[i], d[i + 1], d[i + 2]) + Math.min(d[i], d[i + 1], d[i + 2])) / 510;
      if (d[i + 3] > 200 && L > 0.4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
    }
  }
  if (!n) return null;
  sr /= n; sg /= n; sb /= n;
  for (let y = 0; y < h; y++) {
    const v = y / sy;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] >= 40 && Math.max(d[i], d[i + 1], d[i + 2]) >= 26) continue;
      if (inside && !inside(x / sx, v)) continue;
      d[i] = sr; d[i + 1] = sg; d[i + 2] = sb; d[i + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
  return [sr / 255, sg / 255, sb / 255];
}

let figureTexKey = '';

function applyFigureTextures() {
  if (!model || !model.figure) return;
  const c = cfg || {};
  const outfit = OUTFITS[c.outfit] ? c.outfit : 'uniform';
  const cleavage = clamp(c.cleavage ?? FIG.cleavage, 0, 1);
  const top = TOP_STYLES[c.topStyle] ? c.topStyle : 'full';
  const bottom = BOTTOM_STYLES[c.bottomStyle] ? c.bottomStyle : 'skirt';
  const hair = hex2rgb(c.hairColor, null), eye = hex2rgb(c.eyeColor, null);
  const colors = outfitColors();
  const key = JSON.stringify([outfit, cleavage, top, bottom, c.hairColor, c.eyeColor, c.customVest, c.customSkirt, c.customBow]);
  if (key === figureTexKey) return;
  figureTexKey = key;
  const recolor = !!colors.vest;
  const F = model.figure;
  const cache = new Map(); // source texture -> generated texture (the outline material shares it)
  for (const k in F) {
    const needs = (k === 'tops' && (recolor || cleavage > 0 || top === 'sleeveless' || top === 'crop'))
      || (k === 'skin' && (cleavage > 0 || top !== 'full' || bottom === 'bikini'))
      || ((k === 'skirt' || k === 'bow') && recolor)
      || (k === 'hair' && !!hair) || (k === 'iris' && !!eye);
    for (const f of F[k].list) {
      for (const t of f.generated) t.dispose();
      f.generated = [];
      if (!needs) { f.m.map = f.baseMap = f.map; if (f.shade) f.m.shadeMultiplyTexture = f.baseShade = f.shade; if (k === 'tops') f.m.alphaTest = f.alphaTest; f.m.needsUpdate = true; continue; }
      const process = (src) => {
        if (cache.has(src)) return cache.get(src);
        const img = src.image, w = img.width, h = img.height;
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const sx = w / 2048, sy = h / 2048;
        const cls = CLASSIFY[k];
        const pal = k === 'hair' ? { hair } : k === 'iris' ? { iris: eye } : colors;
        if (cls && (k === 'hair' ? hair : k === 'iris' ? eye : recolor)) {
          const id = g.getImageData(0, 0, w, h);
          recolorPixels(id, cls, pal);
          g.putImageData(id, 0, 0);
        }
        if (k === 'tops') {
          g.globalCompositeOperation = 'destination-out';
          if (cleavage > 0) {
            // V window from the vest seam down between the breasts; past 60% it opens the vest edges too
            const depth = lerp(TOP_UV.vTop, TOP_UV.vDeep, cleavage);
            const half = lerp(0.55, 1.9, cleavage) * (TOP_UV.seamR - TOP_UV.seamL) / 2;
            const topV = TOP_UV.seamV - 60;
            g.beginPath();
            g.moveTo((TOP_UV.midU - half) * sx, topV * sy);
            g.lineTo((TOP_UV.midU + half) * sx, topV * sy);
            g.quadraticCurveTo((TOP_UV.midU + half * 0.5) * sx, (depth - 140) * sy, TOP_UV.midU * sx, depth * sy);
            g.quadraticCurveTo((TOP_UV.midU - half * 0.5) * sx, (depth - 140) * sy, (TOP_UV.midU - half) * sx, topV * sy);
            g.closePath(); g.fill();
          }
          if (top === 'sleeveless' || top === 'crop') {
            g.fillRect(0, 0, TOP_UV.sleeveL * sx, TOP_UV.sleeveV * sy);
            g.fillRect(TOP_UV.sleeveR * sx, 0, w - TOP_UV.sleeveR * sx, TOP_UV.sleeveV * sy);
          }
          if (top === 'crop') g.fillRect(0, TOP_UV.cropV * sy, w, h - TOP_UV.cropV * sy);
          g.globalCompositeOperation = 'source-over';
        }
        if (k === 'skin') {
          // With the top on, only the window the neckline opens needs skin behind it: a V between the
          // breasts, as wide as the neckline and tapering with it. Anything wider — a box round the
          // chest — makes the undersides of her breasts opaque too, and those swing out from under
          // the top when she bounces. A top with parts removed needs the skin everywhere it exposes.
          let inside = null;
          if (top === 'full') {
            const topV = SKIN_UV.neckV - 90, apexV = lerp(620, 800, cleavage);
            const half = lerp(80, 260, cleavage), taper = lerp(0.85, 0.6, cleavage);
            inside = (u, v) => {
              if (bottom === 'bikini' && v >= SKIN_UV.hipTop - 80) return true;   // the skirt is off: hips and legs show
              if (v < topV || v > apexV) return false;
              const t = (v - topV) / (apexV - topV);
              return Math.abs(u - SKIN_UV.midU) <= half * (1 - t * taper);
            };
          }
          const tone = fillSkin(g, w, h, sx, sy, inside) || [0.98, 0.85, 0.78];
          g.save();
          if (cleavage > 0 || top === 'bikini') {
            // soft crease between the breasts plus a little shading on their inner curves
            g.filter = `blur(${Math.round(7 * sx)}px)`;
            const a = top === 'bikini' ? 0.9 : cleavage;
            g.strokeStyle = `rgba(150,70,60,${0.3 * a})`; g.lineCap = 'round'; g.lineWidth = 10 * sx;
            g.beginPath(); g.moveTo(SKIN_UV.midU * sx, (SKIN_UV.creaseTop + 40) * sy); g.lineTo(SKIN_UV.midU * sx, SKIN_UV.creaseBottom * sy); g.stroke();
            g.fillStyle = `rgba(150,70,60,${0.14 * a})`;
            for (const side of [-1, 1]) { g.beginPath(); g.ellipse((SKIN_UV.midU + side * 50) * sx, (SKIN_UV.creaseBottom - 70) * sy, 36 * sx, 115 * sy, 0, 0, Math.PI * 2); g.fill(); }
            g.filter = 'none';
          }
          if (top === 'bikini') {
            // triangle halter bikini top in the outfit's accent colour
            const col = colors.bow || [0.95, 0.35, 0.55], dark = col.map((v) => v * 0.55);
            g.lineJoin = 'round'; g.lineCap = 'round';
            for (const [ax, dir] of [[SKIN_UV.apexL, -1], [SKIN_UV.apexR, 1]]) {
              const tipX = ax + dir * 6, tipY = SKIN_UV.apexV - 175, bl = ax - 92, br = ax + 92, base = SKIN_UV.bandV;
              g.fillStyle = rgb2css(col); g.strokeStyle = rgb2css(dark); g.lineWidth = 4 * sx;
              g.beginPath(); g.moveTo(tipX * sx, tipY * sy); g.quadraticCurveTo((br + 22 * dir) * sx, (base - 90) * sy, br * sx, base * sy);
              g.lineTo(bl * sx, base * sy); g.quadraticCurveTo((bl - 22 * dir) * sx, (base - 90) * sy, tipX * sx, tipY * sy); g.closePath(); g.fill(); g.stroke();
              // halter strap up to the neck
              g.strokeStyle = rgb2css(col); g.lineWidth = 9 * sx;
              g.beginPath(); g.moveTo(tipX * sx, tipY * sy); g.lineTo((SKIN_UV.midU + dir * 10) * sx, SKIN_UV.neckV * sy); g.stroke();
            }
            // under-bust band across the front
            g.strokeStyle = rgb2css(col); g.lineWidth = 12 * sx;
            g.beginPath(); g.moveTo(560 * sx, (SKIN_UV.bandV + 8) * sy); g.lineTo(1490 * sx, (SKIN_UV.bandV + 8) * sy); g.stroke();
          }
          if (bottom === 'bikini') {
            // the model paints underwear onto the skin sheet; tint it to the accent colour so it
            // reads as swimwear, and add hip strings
            const col = colors.bow || [0.95, 0.35, 0.55];
            const id2 = g.getImageData(0, 0, w, h), q = id2.data;
            const y0 = Math.round(SKIN_UV.hipTop * sy);
            for (let y = y0; y < h; y++) for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              if (q[i + 3] < 200) continue;
              const R = q[i] / 255, G = q[i + 1] / 255, B = q[i + 2] / 255;
              if (B <= R + 0.01) continue;                 // skin is peachy (R > B); the painted briefs are cool-toned
              const L = (Math.max(R, G, B) + Math.min(R, G, B)) / 2;
              const k = Math.min(1.5, L / 0.85);
              q[i] = Math.min(255, col[0] * k * 255); q[i + 1] = Math.min(255, col[1] * k * 255); q[i + 2] = Math.min(255, col[2] * k * 255);
            }
            g.putImageData(id2, 0, 0);
            g.strokeStyle = rgb2css(col); g.lineCap = 'round'; g.lineWidth = 10 * sx;
            g.beginPath(); g.moveTo(520 * sx, SKIN_UV.hipStrap * sy); g.lineTo(1530 * sx, SKIN_UV.hipStrap * sy); g.stroke();
          }
          g.restore();
        }
        const t = makeTexture(src, cv);
        f.generated.push(t);
        cache.set(src, t);
        return t;
      };
      f.m.map = f.baseMap = process(f.map);
      if (f.shade) f.m.shadeMultiplyTexture = f.baseShade = process(f.shade);
      if (k === 'tops') f.m.alphaTest = (cleavage > 0 || top !== 'full') ? 0.5 : f.alphaTest;
      f.m.needsUpdate = true;
    }
  }
  woundTexKey = '';   // the skin was rebuilt from scratch: her wounds have to go back on (woundSheet sees the new base)
  syncOutlines();
  scheduleWoundPrebuild();
}

// ---------------------------------------------------------------- trade effects
// profit: she glows — golden rim + emissive on the model, a halo around her
// silhouette (CSS drop-shadow on the canvas) and rising sparkles.
// loss: she gets roughed up — pale skin, a bruised cheek, band-aid, nosebleed,
// a cut brow and scrapes, drawn on a 2D overlay anchored to her bones. Each
// loss stacks more damage; it heals slowly over a couple of minutes, and a
// profit patches her up a bit.
const fx = document.createElement('canvas');
fx.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;will-change:transform';
canvas.after(fx);
const fxg = fx.getContext('2d');
const GOLD = new THREE.Color(1.0, 0.82, 0.38);
const PALE = new THREE.Color(0.88, 0.86, 0.93);
const BRUISE_SHADE = new THREE.Color(0.52, 0.40, 0.58);
let fxApplied = false, lastFilter = '';
const sparks = [];
const _fv = new THREE.Vector3();

// VRoid exports ship with outlines switched off and a very soft shading ramp, which is why an
// untouched VRM looks like a grey plastic maquette next to the same model in VRoid Studio.
// three-vrm only builds outline geometry at load time — flipping outlineWidthMode afterwards does
// nothing — so the outline pass is rebuilt here the same way the loader would have.
const NO_OUTLINE = /eyewhite|eyehighlight|eyeextra|highlight/i;   // a dark ring around the eyeball reads as a bruise
const NO_RIM = /eyeline|eyelash|brow|mouth|eyewhite|highlight/i;  // haloed eyelashes look like smudges
let OUTLINE_SCALE = 0.0029;   // fraction of her height; ≈2 screen px at her usual size

function applyLook(vrm, height) {
  const pairs = [];
  vrm.scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const surf = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!surf || !surf.isMToonMaterial) return;
    const name = surf.name || '';

    // A crisp two-tone ramp instead of a muddy gradient. This is the single biggest difference
    // between "3D model" and "anime character".
    surf.shadingToonyFactor = /hair/i.test(name) ? 0.78 : 0.88;
    surf.shadingShiftFactor = -0.06;

    if (!NO_RIM.test(name)) {
      surf.parametricRimColorFactor?.setHex(0xffdfe8);
      surf.parametricRimFresnelPowerFactor = 3.2;
      surf.parametricRimLiftFactor = 0.015;
      surf.rimLightingMixFactor = 0.42;
    }
    surf.needsUpdate = true;

    if (Array.isArray(o.material)) return;              // it already had an outline pair
    if (NO_OUTLINE.test(name)) return;
    if (o.geometry.groups && o.geometry.groups.length) return;   // multi-material: leave it alone

    surf.outlineWidthMode = 'worldCoordinates';
    surf.outlineWidthFactor = height * OUTLINE_SCALE;
    surf.outlineColorFactor?.setHex(/hair/i.test(name) ? 0x1a1220 : 0x3d1119);
    surf.outlineLightingMixFactor = 0.35;               // mostly flat, so it reads as ink

    const outline = surf.clone();
    outline.name += ' (Outline)';
    outline.isOutline = true;
    outline.side = THREE.BackSide;
    o.material = [surf, outline];
    const g = o.geometry;
    const n = g.index ? g.index.count : g.attributes.position.count / 3;
    g.addGroup(0, n, 0);
    g.addGroup(0, n, 1);
    pairs.push([surf, outline]);
  });
  return pairs;
}

// The outfit editor swaps textures on the surface material; its outline twin holds its own
// reference and would keep cutting the old silhouette (most visibly around a new neckline).
function syncOutlines() {
  if (!model || !model.outlinePairs) return;
  for (const [surf, outline] of model.outlinePairs) {
    outline.map = surf.map;
    outline.alphaTest = surf.alphaTest;
    outline.transparent = surf.transparent;
    outline.needsUpdate = true;
  }
}

function collectMaterials(root) {
  const out = [], seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m) || m.isOutline) continue;
      seen.add(m);
      const n = (m.name || '').toLowerCase();
      const skin = /skin|hada/.test(n) || (/face|body|kao|karada/.test(n) && !/hair|cloth|eye|mouth|brow|lash|tooth|iris|kami|fuku/.test(n));
      out.push({
        m, skin,
        color: m.color?.isColor ? m.color.clone() : null,
        shade: m.shadeColorFactor?.isColor ? m.shadeColorFactor.clone() : null,
        emissive: m.emissive?.isColor ? m.emissive.clone() : null,
        ei: m.emissiveIntensity,
        rimColor: m.parametricRimColorFactor?.isColor ? m.parametricRimColorFactor.clone() : null,
        rimPow: m.parametricRimFresnelPowerFactor, rimMix: m.rimLightingMixFactor,
      });
    }
  });
  return out;
}

// wound catalogue: threshold of `pet.hurt` at which each appears, roughly in order of severity
const WOUNDS = [
  { type: 'bruise', thr: 0.05, dx: 0.6, dy: -0.15, r: 0.42 },
  { type: 'bandaid', thr: 0.3, dx: -0.62, dy: -0.12 },
  { type: 'trickle', thr: 0.35, dx: 0.12, dy: -0.2, len: 0.55, w: 0.075 },        // nosebleed
  { type: 'scrape', thr: 0.5, bone: 'leftLowerArm', bone2: 'leftHand', k: 0.5 },      // forearm
  { type: 'cut', thr: 0.6, dx: 0.46, dy: 0.1, len: 0.34, w: 0.055 },             // split cheekbone; her fringe covers the brow, so a wound up there floats on hair
  { type: 'bruise', thr: 0.75, dx: -0.45, dy: 0.12, r: 0.34 },                   // black eye, sitting under the eye so it does not paint over it
  { type: 'scrape', thr: 0.8, bone: 'rightLowerLeg', bone2: 'rightFoot', k: 0.12 },   // just below the knee
  { type: 'lip', thr: 0.85, dx: -0.18, dy: -0.55 },
];

function addHurt(amount) {
  pet.hurt = clamp(pet.hurt + amount, 0, 1);
  for (const w of WOUNDS) {
    if (pet.hurt < w.thr) continue;
    let ex = pet.wounds.find((x) => x.def === w);
    if (!ex) pet.wounds.push({ def: w, born: T, seed: Math.random() });
    else if (w.type === 'bruise') ex.born = Math.min(ex.born, T - 0.5); // bruises deepen instead of re-appearing
  }
}
function healHurt(amount) { pet.hurt = clamp(pet.hurt - amount, 0, 1); }

function addGlow(amount) {
  pet.glow = clamp(Math.max(pet.glow, amount), 0, 1);
  for (let i = 0; i < 18 * amount; i++) spawnSpark(1);
}

function spawnSpark(burst = 0) {
  if (!model) return;
  const h = model.height;
  sparks.push({
    // position relative to her root, in world units; drifts upward
    x: rand(-0.35, 0.35) * h * (burst ? 1.2 : 1), y: rand(0.05, 1.05) * h,
    vx: rand(-0.06, 0.06) * h, vy: rand(0.12, 0.3) * h * (burst ? 1.5 : 1),
    life: 0, dur: rand(0.9, 1.6), size: rand(2.5, 6.5), spin: rand(0, Math.PI),
  });
}
// a confetti cannon: coloured slips that burst up and tumble down
const CONFETTI = ['#ff6fae', '#7c5cff', '#34d5c9', '#ffd166', '#3fe0a5', '#ffffff'];
function spawnConfetti(n) {
  if (!model) return;
  const h = model.height;
  for (let i = 0; i < n; i++) sparks.push({
    x: rand(-0.2, 0.2) * h, y: rand(0.55, 0.95) * h,
    vx: rand(-0.7, 0.7) * h, vy: rand(0.5, 1.3) * h,
    life: 0, dur: rand(1.8, 2.8), size: rand(7, 12), spin: rand(0, Math.PI * 2),
    confetti: pick(CONFETTI), spinV: rand(-8, 8), grav: 1.1 * h,
  });
}

function updateFx(dt) {
  if (!model) return;
  if (pet.glow > 0) {
    pet.glow = Math.max(0, pet.glow - dt / 14);
    if (Math.random() < dt * 14 * pet.glow) spawnSpark();
  }
  if (pet.hurt > 0) pet.hurt = Math.max(0, pet.hurt - dt / 120);
  // wounds vanish one by one as she heals (the worst ones first)
  pet.wounds = pet.wounds.filter((w) => pet.hurt > w.def.thr * 0.45);
  const wk = woundKeyNow();
  if (wk !== woundTexKey && model.figure) { woundTexKey = wk; const t0 = performance.now(), builtBefore = paintMs.builds; paintWounds(); paintMs.last = performance.now() - t0; paintMs.n++; if (paintMs.builds > builtBefore) paintMs.buildMs = Math.max(paintMs.buildMs, paintMs.last); else paintMs.max = Math.max(paintMs.max, paintMs.last); }
  flushWoundQueue();
  for (const s of sparks) { s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt; if (s.confetti) { s.vy -= s.grav * dt; s.vx *= 1 - 1.4 * dt; s.spin += s.spinV * dt; } else s.vy *= 1 - 0.6 * dt; }
  for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].life >= sparks[i].dur) sparks.splice(i, 1);

  const g = pet.glow, h = pet.hurt;
  if (g > 0 || h > 0 || fxApplied) {
    const pulse = g * (0.8 + 0.2 * Math.sin(T * 5.5));
    for (const r of model.mats) {
      const m = r.m;
      if (r.emissive) { m.emissive.copy(r.emissive).add(_fc.copy(GOLD).multiplyScalar(0.3 * pulse)); m.emissiveIntensity = g > 0 ? Math.max(r.ei ?? 1, 1) : r.ei; }
      if (r.rimColor) {
        m.parametricRimColorFactor.copy(r.rimColor).lerp(GOLD, pulse);
        m.parametricRimFresnelPowerFactor = lerp(r.rimPow, 2.6, g);
        m.rimLightingMixFactor = lerp(r.rimMix, 0, g);
      }
      if (r.skin) {
        if (r.color) m.color.copy(r.color).lerp(PALE, 0.4 * h);
        if (r.shade) m.shadeColorFactor.copy(r.shade).lerp(BRUISE_SHADE, 0.55 * h);
      }
    }
    fxApplied = g > 0 || h > 0;
    let f = '';
    if (g > 0) f += `drop-shadow(0 0 ${(4 + 14 * pulse).toFixed(1)}px rgba(255,214,110,${(0.9 * pulse).toFixed(2)})) drop-shadow(0 0 ${(16 + 30 * pulse).toFixed(0)}px rgba(255,170,60,${(0.55 * pulse).toFixed(2)}))`;
    if (h > 0) f += ` saturate(${(1 - 0.32 * h).toFixed(3)}) brightness(${(1 - 0.07 * h).toFixed(3)})`;
    if (f !== lastFilter) { canvas.style.filter = f; lastFilter = f; }
  }
}
const _fc = new THREE.Color();

// world → overlay-canvas CSS px (the overlay is the same square as the WebGL canvas)
function projFx(v) {
  const p = _fv.copy(v).project(camera);
  return { x: (p.x + 1) * 0.5 * CS, y: (1 - p.y) * 0.5 * CS };
}
function bonePx(name) {
  const b = model.bones[name];
  if (!b) return null;
  _fv.setFromMatrixPosition(b.matrixWorld);
  return projFx(_fv);
}
// The same bone in *window* px: bonePx is local to the render canvas, which is translated to
// follow her, so anything laid out in the DOM around her has to add that translation back.
function boneScreen(name) {
  const p = bonePx(name);
  return p && { x: p.x + canvasLeft, y: p.y + canvasTop };
}

// Blood drawn as a stroked line reads as a red stick: constant width, blunt ends, no direction.
// This lays down a filled ribbon instead — widest at the wound, tapering to the drip — by walking
// a curve and offsetting each side by the half-width at that point.
function bloodStreak(g, x, y, len, w0, wob, fill) {
  const N = 14, L = [], R = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // a quadratic that drifts sideways, plus a little wander so no two streaks are alike
    const cx = x + wob * (t * (1 - t) * 4) + Math.sin(t * 5.1 + wob) * w0 * 0.35;
    const cy = y + len * t;
    const w = w0 * (1 - 0.72 * t) * (1 - 0.25 * Math.sin(t * 9));   // thins and pulses as it runs
    L.push([cx - w, cy]); R.push([cx + w, cy]);
  }
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(L[0][0], L[0][1]);
  for (const p of L) g.lineTo(p[0], p[1]);
  for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
  g.closePath(); g.fill();
  return { x: L[N][0] + w0 * (1 - 0.72), y: L[N][1] };
}

// ---- wounds, painted into her skin -----------------------------------------------------------
// They used to be drawn on the 2D overlay, projected from her bones: they floated in front of her,
// ignored her hair and hands, took no shading and stayed put when her face moved. Now they are
// painted straight into the face and body skin textures (lit and shade maps both), so a bruise
// curves with her cheek, sits under her fringe, darkens in shadow and moves with her expressions.
//
// Each wound is anchored once by casting a ray from the front at the spot the overlay used to draw
// it. The hit gives the texture coordinate under that spot and which skin it is; two more rays a
// little to her right and downwards give how texture space stretches there, so the same drawing
// code runs under a canvas transform instead of being re-authored for every model's UV layout.
let woundTexKey = '';
const paintMs = { last: 0, max: 0, n: 0, draw: 0, upload: 0, regions: 0, px: 0, sheets: 0, builds: 0, buildMs: 0, readMax: 0, glMax: 0, glMaxAt: '', flushes: 0, anchorMax: 0 };   // how long the last / worst wound repaint took on the main thread
const _ray = new THREE.Raycaster(), _rayO = new THREE.Vector3(), _rayD = new THREE.Vector3(0, 0, -1);
const _wa = new THREE.Vector3(), _wb = new THREE.Vector3();
function skinRecord(mat) {
  for (const k of ['face', 'skin']) for (const f of (model.figure[k] || { list: [] }).list) if (f.m === mat) return f;
  return null;
}
// the meshes carrying each skin sheet. A ray only needs the mesh a wound can land on: raycasting a
// skinned mesh re-skins every vertex it holds, so asking the whole body about a cheek costs ~50 ms
function skinMeshes(kind) {
  const out = [];
  model.vrm.scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if ((Array.isArray(o.material) ? o.material : [o.material]).some((m) => (model.figure[kind] || { list: [] }).list.some((f) => f.m === m))) out.push(o);
  });
  return out;
}
// the skin under a point, seen from the front: which texture, and where on it (null if only hair or clothes are there)
function skinUnder(x, y, kind) {
  model.skinMeshes ||= {};
  const meshes = model.skinMeshes[kind] ||= skinMeshes(kind);
  _ray.set(_rayO.set(x, y, model.root.position.z + 4), _rayD);
  for (const hit of _ray.intersectObjects(meshes, false)) {
    if (!hit.uv || !hit.face) continue;
    const mats = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
    const f = skinRecord(mats[hit.face.materialIndex] || mats[0]);
    if (f) return { f, u: hit.uv.x, v: hit.uv.y };
  }
  return null;
}
function woundAnchor(w) {
  if (w.anchor !== undefined) return w.anchor;
  // the rays come from the front, so wait until she is more or less facing it
  if (Math.abs(pet.yaw) > 0.25 || Math.abs(pet.theta) > 0.25) return null;
  const d = w.def;
  const R = 0.052 * model.height;                   // face radius (anime head ≈ 1/7 of height)
  let px, py, rx, ry, dx, dy, ang = 0;
  if (d.bone) {
    const b1 = model.bones[d.bone], b2 = model.bones[d.bone2];
    if (!b1 || !b2) return (w.anchor = null);
    _wa.setFromMatrixPosition(b1.matrixWorld); _wb.setFromMatrixPosition(b2.matrixWorld);
    px = lerp(_wa.x, _wb.x, d.k); py = lerp(_wa.y, _wb.y, d.k);
    ang = Math.atan2(-(_wb.y - _wa.y), _wb.x - _wa.x) + 0.6;       // the limb's direction, in a right/down frame
    rx = 1; ry = 0; dx = 0; dy = -1;
  } else {
    const hb = model.bones.head, nb = model.bones.neck || model.bones.upperChest || model.bones.chest;
    if (!hb || !nb) return (w.anchor = null);
    _wa.setFromMatrixPosition(hb.matrixWorld); _wb.setFromMatrixPosition(nb.matrixWorld);
    let ux = _wa.x - _wb.x, uy = _wa.y - _wb.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
    rx = uy; ry = -ux; dx = -ux; dy = -uy;           // her screen-right, and down her face
    // the head bone sits at the jaw on VRM rigs; the face centre (between eyes and mouth) is a bit above it
    const fx = _wa.x + ux * R * 0.42, fy = _wa.y + uy * R * 0.42;
    px = fx + rx * d.dx * R + ux * d.dy * R; py = fy + ry * d.dx * R + uy * d.dy * R;
  }
  const kind = d.bone ? 'skin' : 'face';
  const h0 = skinUnder(px, py, kind);
  if (!h0) { bridge.log(`wound ${d.type}: no ${kind} skin under (${px.toFixed(3)}, ${py.toFixed(3)})`); return (w.anchor = null); }
  const eps = 0.3 * R;
  const hr = skinUnder(px + rx * eps, py + ry * eps, kind), hd = skinUnder(px + dx * eps, py + dy * eps, kind);
  let dr = hr && hr.f === h0.f ? [(hr.u - h0.u) / eps, (hr.v - h0.v) / eps] : null;
  let dd = hd && hd.f === h0.f ? [(hd.u - h0.u) / eps, (hd.v - h0.v) / eps] : null;
  if (!dr && !dd) { bridge.log(`wound ${d.type}: skin found but no texture gradient`); return (w.anchor = null); }
  if (!dr) dr = [dd[1], -dd[0]];                    // one side ray landed off the skin: assume square texels
  if (!dd) dd = [-dr[1], dr[0]];
  return (w.anchor = { f: h0.f, u: h0.u, v: h0.v, dr, dd, R, ang });
}
// Everything the painting depends on, so a repaint happens only when something changed: the wound
// list, a wound's age (fine steps while it is fresh and still growing, coarse once it has set) and
// how hurt she is, which sets how strongly each one shows.
function woundKeyNow() {
  if (!model || !model.figure) return '';
  if (!pet.wounds.length || pet.hurt <= 0) return 'none';
  // Each repaint copies and re-uploads two 2048² sheets — a visible hitch — so the steps are
  // coarse: half-second stages while a wound is opening, two more as it sets, and eight shades of hurt.
  return figureTexKey + '|' + Math.round(pet.hurt * 8) + '|' + pet.wounds.map((w) => {
    const age = T - w.born;
    const stage = age < 5 ? Math.round(age / 0.5) : age < 12 ? 'a' : age < 25 ? 'b' : 'set';
    return w.def.type + w.def.thr + ':' + stage + (w.anchor === undefined ? '?' : '');
  }).join(',');
}
// Painting used to mean copying each 2048² sheet, making four new GPU textures, uploading ~40 MB
// and rebuilding every outline material — on the main thread, again every half-second while a
// wound was fresh. Spam a loss and she stalled. Now each sheet keeps ONE persistent canvas and
// texture, built once shortly after the model loads. A repaint redraws only the patch under each
// wound (base pixels back, then the wounds that touch it) and queues that patch; a couple of
// patches go up per frame with texSubImage2D, and a sheet's mips are rebuilt once when its queue
// drains. Nothing is allocated per repaint, no material is rebuilt, no frame pays for all of it.
// how far each wound can draw from its anchor, in face radii: the patch is sized to the wound, not to a worst case
const WOUND_REACH = { bruise: 0.46, bandaid: 0.42, trickle: 0.72, cut: 0.48, lip: 0.1, scrape: 0.55 };
const PATCHES_PER_FRAME = 1;
// Patches are uploaded per mip level rather than regenerating a sheet's whole chain (which stalls
// ~40 ms on a 2048² texture). Regions are aligned to 2^MIP_LEVELS texels so every level's patch
// lands exactly; the levels below that see a few-hundred-pixel change as nothing.
const MIP_LEVELS = 5;
// 2x2 box filter, one mip level down. A few hundred pixels: cheaper in JS than a canvas round-trip.
function halve(src, w, h) {
  const w2 = w >> 1, h2 = h >> 1, out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const r0 = (y * 2) * w * 4, r1 = r0 + w * 4;
    for (let x = 0; x < w2; x++) {
      const i0 = r0 + x * 8, i1 = r1 + x * 8, o = (y * w2 + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (src[i0 + c] + src[i0 + 4 + c] + src[i1 + c] + src[i1 + 4 + c] + 2) >> 2;
    }
  }
  return out;
}
// One patch of one mip level, straight to the GPU. three's copyTextureToTexture would issue the
// same texSubImage2D but reads five GL parameters back first, each a synchronous round-trip to the
// GPU process — that, not the pixels, was the stall. The texture is bound through three's own
// state cache so nothing it believes about bindings goes stale.
function uploadPatch(tex, level, x, y, w, h, data) {
  const p = renderer.properties.get(tex);
  if (!p || !p.__webglTexture) return false;
  const gl = renderer.getContext();
  renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, tex.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, tex.premultiplyAlpha);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return true;
}
const woundQueue = [];   // [{ s, r }] patches drawn but not yet on the GPU
function woundSheet(f, src, key) {
  let s = f[key];
  if (s && s.base === src) return s;
  if (s) { s.dead = true; s.tex.dispose(); }
  const img = src.image;
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d', { willReadFrequently: true });   // CPU-backed: reading a patch back out is then just a memcpy
  g.drawImage(img, 0, 0);
  const tex = makeTexture(src, cv);            // the one full upload, when the base sheet itself changes
  tex.generateMipmaps = false;                 // mips are rebuilt by remip(), once per drained queue
  renderer.initTexture(tex); remip(tex);       // upload now, so the first wound is only ever a patch
  paintMs.builds++;
  s = f[key] = { base: src, cv, g, tex, painted: [], pending: 0, dead: false };
  return s;
}
// She is small on screen, so her skin is sampled from the smaller mip levels: a patch that only
// touched level 0 would leave the wound invisible. One rebuild per sheet per drained queue.
function remip(tex) {
  const p = renderer.properties.get(tex);
  if (!p || !p.__webglTexture) return;
  const gl = renderer.getContext();
  renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
  gl.generateMipmap(gl.TEXTURE_2D);
}
// the rectangle of texture pixels a wound can touch, clamped to the sheet
function woundRegion(w, src, W, H) {
  const A = w.anchor;
  const flip = src.flipY ? -1 : 1, cy = src.flipY ? (1 - A.v) * H : A.v * H, cx = A.u * W;
  const a11 = A.dr[0] * A.R * W, a21 = A.dr[1] * A.R * H * flip, a12 = A.dd[0] * A.R * W, a22 = A.dd[1] * A.R * H * flip;
  const reach = WOUND_REACH[w.def.type] || 0.6;
  const hx = Math.ceil(reach * (Math.abs(a11) + Math.abs(a12))) + 2, hy = Math.ceil(reach * (Math.abs(a21) + Math.abs(a22))) + 2;
  const G = 1 << MIP_LEVELS;
  const x0 = Math.max(0, Math.floor((cx - hx) / G) * G), y0 = Math.max(0, Math.floor((cy - hy) / G) * G);
  const x1 = Math.min(W, Math.ceil((cx + hx) / G) * G), y1 = Math.min(H, Math.ceil((cy + hy) / G) * G);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
const sameRegion = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
function repaintSheet(s, src, list) {
  const W = s.cv.width, H = s.cv.height;
  const regions = list.map((w) => woundRegion(w, src, W, H)).filter(Boolean);
  // regions painted last time and not any more (a wound that healed) go back to bare skin too
  for (const r of s.painted) if (!regions.some((q) => sameRegion(q, r))) regions.push(r);
  const g = s.g; paintMs.sheets++;
  for (const r of regions) {
    const tD = performance.now(); paintMs.regions++; paintMs.px += r.w * r.h;
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    g.clearRect(r.x, r.y, r.w, r.h);
    g.drawImage(src.image, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    for (const w of list) drawWoundInto(g, w, src, W, H);
    g.restore();
    paintMs.draw += performance.now() - tD;
    // a patch already waiting for the same rectangle will pick up these pixels when it goes
    if (!woundQueue.some((q) => q.s === s && sameRegion(q.r, r))) { woundQueue.push({ s, r }); s.pending++; }
  }
  s.painted = list.map((w) => woundRegion(w, src, W, H)).filter(Boolean);
}
// a couple of patches per frame, then the mips once a sheet has nothing left waiting
function flushWoundQueue() {
  if (!woundQueue.length) return;
  const t0 = performance.now();
  for (let i = 0; i < PATCHES_PER_FRAME && woundQueue.length; i++) {
    const { s, r } = woundQueue.shift();
    s.pending--;
    if (s.dead) continue;
    const H = s.cv.height;
    try {
      const tR = performance.now();
      let data = s.g.getImageData(r.x, r.y, r.w, r.h).data, w = r.w, h = r.h;
      paintMs.readMax = Math.max(paintMs.readMax, performance.now() - tR);
      for (let L = 0; L <= MIP_LEVELS; L++) {
        const tG = performance.now();
        const y = s.tex.flipY ? (H >> L) - (r.y >> L) - h : r.y >> L;   // GL rows run from the bottom when the sheet was flipped on upload
        if (!uploadPatch(s.tex, L, r.x >> L, y, w, h, data)) throw new Error('sheet texture is not on the GPU yet');
        const g = performance.now() - tG; if (g > paintMs.glMax) { paintMs.glMax = g; paintMs.glMaxAt = 'L' + L + ' ' + w + 'x' + h + ' sheet ' + s.cv.width; }
        if ((w >> 1) < 1 || (h >> 1) < 1) break;
        data = halve(data, w, h); w >>= 1; h >>= 1;
      }
    } catch (e) { bridge.log('wound patch upload: ' + e.message); s.tex.needsUpdate = true; remip(s.tex); }   // fall back to a full upload
  }
  const ms = performance.now() - t0; paintMs.flushes++;
  paintMs.upload += ms; paintMs.max = Math.max(paintMs.max, ms);
}
// The sheets are built a moment after the skin textures are ready — not on the first loss, when
// the one full upload each needs would land in the middle of her reaction.
let woundPrebuildTimer = null;
function scheduleWoundPrebuild() {
  clearTimeout(woundPrebuildTimer);
  woundPrebuildTimer = setTimeout(() => { if (model && model.figure) prebuildWoundSheets(); }, 700);
}
function prebuildWoundSheets() {
  const F = model.figure;
  let mapsChanged = false;
  for (const k of ['face', 'skin']) for (const f of (F[k] || { list: [] }).list) {
    const base = f.baseMap || f.map, baseShade = f.baseShade || f.shade;
    const lit = woundSheet(f, base, 'litSheet');
    if (f.m.map !== lit.tex) { f.m.map = lit.tex; mapsChanged = true; }
    f.woundCanvas = lit.cv;   // the self-test saves the painted sheet and looks at it
    if (baseShade) {
      const sh = woundSheet(f, baseShade, 'shadeSheet');
      if (f.m.shadeMultiplyTexture !== sh.tex) { f.m.shadeMultiplyTexture = sh.tex; mapsChanged = true; }
    }
  }
  // only when a material was pointed at a new texture object — never for a repaint of pixels
  if (mapsChanged) syncOutlines();
}
function paintWounds() {
  const F = model.figure;
  const byTex = new Map();
  let anchored = 0;
  if (pet.hurt > 0) for (const w of pet.wounds) {
    let a = w.anchor;
    if (a === undefined) { if (anchored++) continue; const t0 = performance.now(); a = woundAnchor(w); paintMs.anchorMax = Math.max(paintMs.anchorMax, performance.now() - t0); }
    if (a) { if (!byTex.has(a.f)) byTex.set(a.f, []); byTex.get(a.f).push(w); }
  }
  let mapsChanged = false;
  for (const k of ['face', 'skin']) for (const f of (F[k] || { list: [] }).list) {
    const list = byTex.get(f) || [];
    const base = f.baseMap || f.map, baseShade = f.baseShade || f.shade;
    // a sheet that has never had a wound and has none now needs nothing at all
    if (!list.length && !(f.litSheet && f.litSheet.painted.length)) continue;
    const lit = woundSheet(f, base, 'litSheet');
    repaintSheet(lit, base, list);
    if (f.m.map !== lit.tex) { f.m.map = lit.tex; mapsChanged = true; }
    f.woundCanvas = lit.cv;
    if (baseShade) {
      const sh = woundSheet(f, baseShade, 'shadeSheet');
      repaintSheet(sh, baseShade, list);
      if (f.m.shadeMultiplyTexture !== sh.tex) { f.m.shadeMultiplyTexture = sh.tex; mapsChanged = true; }
    }
  }
  if (mapsChanged) syncOutlines();
}
// One wound onto one texture. The canvas is transformed so that the wound's own anchor is the
// origin, x runs to her right and y down her face, in units of the face radius; the drawing itself
// is the overlay's, unchanged in spirit.
function drawWoundInto(g, w, src, W, H) {
  const A = w.anchor, d = w.def;
  const flip = src.flipY ? -1 : 1, y0 = src.flipY ? (1 - A.v) * H : A.v * H;
  const a11 = A.dr[0] * A.R * W, a21 = A.dr[1] * A.R * H * flip, a12 = A.dd[0] * A.R * W, a22 = A.dd[1] * A.R * H * flip;
  if (Math.abs(a11 * a22 - a12 * a21) < 1e-6) return;   // degenerate: the two side rays landed on the same texel
  const grow = smoothstep((T - w.born) / 1.4);
  const alpha = smoothstep(pet.hurt / 0.2) * grow * clamp((pet.hurt - d.thr * 0.45) / (d.thr * 0.35), 0, 1);
  if (alpha <= 0.01) return;
  g.save();
  g.setTransform(a11, a21, a12, a22, A.u * W, y0);
  g.globalAlpha = alpha;
  if (d.type === 'bruise') {
    const r = d.r;
    const deep = clamp((T - w.born) / 20, 0, 1) * 0.35 + 0.35 * pet.hurt;   // darkens over time / with more losses
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, `rgba(96,38,116,${0.6 * deep + 0.4})`);
    gr.addColorStop(0.5, `rgba(128,66,134,${0.4 * deep + 0.2})`);
    // the sallow ring an older bruise gets; it is what stops this reading as a purple sticker
    gr.addColorStop(0.82, `rgba(150,138,74,${0.22 * deep + 0.1})`);
    gr.addColorStop(1, 'rgba(150,130,90,0)');
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(0, 0, r, r * 0.8, 0.4, 0, Math.PI * 2); g.fill();
  } else if (d.type === 'bandaid') {
    const L = 0.62, Wd = 0.2;
    for (const rot of [-0.7, 0.7]) {
      g.save(); g.rotate(rot);
      g.fillStyle = '#dcae7e'; roundRect(g, -L / 2, -Wd / 2, L, Wd, Wd / 2); g.fill();
      g.strokeStyle = 'rgba(120,78,44,0.55)'; g.lineWidth = Wd * 0.07;
      roundRect(g, -L / 2, -Wd / 2, L, Wd, Wd / 2); g.stroke();
      g.fillStyle = '#f6ecd9'; roundRect(g, -L * 0.19, -Wd * 0.34, L * 0.38, Wd * 0.68, Wd * 0.18); g.fill();
      // the little perforations either side of the pad
      g.fillStyle = 'rgba(120,78,44,0.4)';
      for (const sx of [-1, 1]) for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(sx * L * 0.33, i * Wd * 0.26, Wd * 0.05, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
  } else if (d.type === 'trickle' || d.type === 'cut') {
    if (d.type === 'cut') {
      // a short slash along the cheekbone, dark in the middle and thin at both ends
      const half = 0.15;
      g.strokeStyle = '#6d0d14'; g.lineCap = 'round'; g.lineWidth = 0.028;
      g.beginPath(); g.moveTo(-half, 0.03); g.quadraticCurveTo(0, 0.02, half, -0.05); g.stroke();
    }
    // blood runs down her face; the streak lengthens over the first few seconds
    const len = d.len * smoothstep((T - w.born) / 4.5);
    const wob = Math.sin(w.seed * 20) * 0.1;
    const wd = d.w * 0.62;
    const tip = bloodStreak(g, 0, 0, len, wd, wob, '#9c1019');
    g.fillStyle = '#b3141f'; g.beginPath(); g.ellipse(tip.x, tip.y, wd * 0.85, wd * 1.15, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6d0d14'; g.beginPath(); g.ellipse(0, 0, wd * 1.05, wd * 0.8, 0, 0, Math.PI * 2); g.fill();
    // one specular sliver so it looks wet rather than painted
    g.globalAlpha = alpha * 0.4; g.fillStyle = '#ff7a86';
    g.beginPath(); g.ellipse(-wd * 0.3, len * 0.32, wd * 0.22, len * 0.16, 0, 0, Math.PI * 2); g.fill();
  } else if (d.type === 'lip') {
    g.fillStyle = '#9c1219'; g.beginPath(); g.arc(0, 0, 0.07, 0, Math.PI * 2); g.fill();
  } else if (d.type === 'scrape') {
    g.rotate(A.ang);
    const S = 0.02 / 0.052;                          // the overlay's 2% of her height, in face radii
    // a soft raw patch under it, so the grazes sit on reddened skin instead of bare arm
    const gr2 = g.createRadialGradient(0, 0, 0, 0, 0, S);
    gr2.addColorStop(0, 'rgba(176,54,58,0.42)'); gr2.addColorStop(1, 'rgba(176,54,58,0)');
    g.fillStyle = gr2; g.beginPath(); g.ellipse(0, 0, S, S * 0.62, 0, 0, Math.PI * 2); g.fill();
    // short broken strokes at scattered angles; three even parallel lines would read as a barcode
    g.strokeStyle = 'rgba(140,26,34,0.9)'; g.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const q = Math.sin(w.seed * 100 + i * 12.9898) * 0.5 + 0.5;
      const q2 = Math.sin(w.seed * 57 + i * 78.233) * 0.5 + 0.5;
      const ox = (q - 0.5) * S * 1.7, oy = (q2 - 0.5) * S * 1.05;
      const l = S * (0.28 + q2 * 0.5), aa = (q - 0.5) * 0.7;
      g.lineWidth = 0.0022 / 0.052 * (0.7 + q * 0.8);
      g.beginPath(); g.moveTo(ox - Math.cos(aa) * l / 2, oy - Math.sin(aa) * l / 2); g.lineTo(ox + Math.cos(aa) * l / 2, oy + Math.sin(aa) * l / 2); g.stroke();
    }
  }
  g.restore();
}

function drawFx() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(CS * dpr);
  if (fx.width !== bw || fx.height !== bw) { fx.width = fx.height = bw; }
  fxg.setTransform(dpr, 0, 0, dpr, 0, 0);
  fxg.clearRect(0, 0, CS, CS);
  if (!model || sparks.length === 0) return;

  // ---- sparkles
  if (sparks.length) {
    const c = Math.cos(pet.theta), s = Math.sin(pet.theta);
    for (const sp of sparks) {
      const k = sp.life / sp.dur, a = Math.sin(Math.PI * k);
      // spark position: her root frame rotated by her tilt, so they cling to her when she swings
      _fv.set(pet.x + (c * sp.x - s * sp.y), pet.y + pet.bob + pet.crouch + (s * sp.x + c * sp.y), 0.3);
      const p = projFx(_fv);
      const r = sp.size * (0.6 + 0.4 * a);
      fxg.save(); fxg.translate(p.x, p.y); fxg.rotate(sp.spin + (sp.confetti ? 0 : k * 2));
      fxg.globalAlpha = sp.confetti ? Math.min(1, (1 - k) * 3) : a * 0.95;
      if (sp.confetti) { fxg.fillStyle = sp.confetti; fxg.fillRect(-r * 1.1, -r * 0.45, r * 2.2, r * 0.9); }
      else {
        fxg.fillStyle = k < 0.5 ? '#fff4c2' : '#ffd36b';
        fxg.beginPath();
        for (let i = 0; i < 8; i++) { const rr = i % 2 ? r * 0.32 : r; const t = (i / 8) * Math.PI * 2; fxg.lineTo(Math.cos(t) * rr, Math.sin(t) * rr); }
        fxg.closePath(); fxg.fill();
      }
      fxg.restore();
    }
    fxg.globalAlpha = 1;
  }
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h);
  g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}

// ---------------------------------------------------------------- main loop
function step(dt) {
  T += dt;
  updateState(dt);
  companionTick(dt);
  const root = model.root;
  const sq = clamp(pet.squash.update(1, dt), 0.6, 1.25);
  root.position.set(pet.x, pet.y + pet.bob + pet.crouch, 0);
  root.rotation.set(0, pet.yaw, pet.theta);
  root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
  updateView();
  applyPose(dt);
  applyExpressions(dt);
  lookTarget.position.set(cursor.wx, cursor.wy, Math.min(4, camDist * 0.5));
  // fade spring-bone gravity out as she tilts past horizontal, so skirts and hair
  // keep their rest shape instead of flipping over when she hangs upside-down
  const gs = damp(model.gravityScale, clamp(Math.cos(pet.theta) * 1.5, 0, 1), 12, dt);
  if (Math.abs(gs - model.gravityScale) > 1e-4) {
    model.gravityScale = gs;
    for (const { j, g } of model.joints) j.settings.gravityPower = g * gs;
  }
  model.vrm.update(dt);
  amplifyBust(dt);
  updateFx(dt);
  updateSign(dt);
  if (springResetPending > 0) { springResetPending--; model.vrm.springBoneManager?.reset(); }
}

let lastIgnore = null;
function draw() {
  renderer.render(scene, camera);
  drawFx();
  // hit test (uses the world matrices just computed by the render)
  const hit = cursor.down && pet.grab ? (cursor.hit || 'hips') : hitTest();
  // the window only catches the mouse over her or over the open panel; everywhere else clicks go
  // to whatever is underneath (a chart, a browser) even while the panel is open
  const sh = sign ? signHitTest() : { over: false, close: false, badge: null };
  if (sign && sh.over !== sign.hover) sign.hover = sh.over;
  if (panelOpen) positionPanel(false);
  if (tourActive) { positionTour(); tourTick(); }
  if (panelOpen && panelTab === 'wallet' && T - lastTradeTick > 1) { lastTradeTick = T; refreshRelayStatus(); }
  let overPanel = false;
  if (panelOpen && cursor.seen) { const r = panelEl.getBoundingClientRect(); overPanel = cursor.sx >= r.left - 8 && cursor.sx <= r.right + 8 && cursor.sy >= r.top - 8 && cursor.sy <= r.bottom + 8; }
  if (!overPanel && tourActive && cursor.seen) { const r = tourEl.getBoundingClientRect(); overPanel = cursor.sx >= r.left - 8 && cursor.sx <= r.right + 8 && cursor.sy >= r.top - 8 && cursor.sy <= r.bottom + 8; }
  // only the close badge catches the mouse: clicks anywhere else on the board still reach the chart
  const wantIgnore = !hit && !overPanel && !sh.badge;
  if (wantIgnore !== lastIgnore) { bridge.setIgnore(wantIgnore); lastIgnore = wantIgnore; }
  cursor.hit = hit;
  updateBubble();
  canvas.style.cursor = sh.badge ? 'pointer' : hit ? (cursor.down ? 'grabbing' : 'grab') : 'default';
}

let lastFrame = performance.now();
let paused = false; // set by the test harness, which steps manually
// She stands on someone's desktop for hours while they trade and stream, so the cheapest frame is
// the one that is never drawn. Left to requestAnimationFrame she renders at the monitor's refresh
// rate — 180fps on a fast panel — to show a girl breathing. Cap that, and once nothing has moved
// for a few seconds drop further still. Anything that actually animates pulls her straight back up.
// Smoothness over savings: full refresh rate while anything moves (a 144 cap only bites on very
// fast panels), 60 when she is standing still. The old 60/30 made every fidget stutter.
const FPS_ACTIVE = 144, FPS_CALM = 60;
const CALM_AFTER = 2.5;   // seconds of stillness before easing off; covers a settling jiggle
let calmFor = 0;
let drawnFrames = 0;   // frames actually rendered, so the cap can be measured rather than assumed
function busy() {
  return (pet.state !== 'idle' && pet.state !== 'sleep') || !!pet.micro || !pet.onGround || cursor.down || panelOpen
    || sparks.length > 0 || pet.glow > 0
    || Math.abs(pet.vx) > 0.01 || Math.abs(pet.vy) > 0.01 || Math.abs(pet.theta) > 0.01
    || (sign && sign.phase !== 'hidden' && sign.phase !== 'held')
    || bubbleUntil > T
    || T - pet.lastInteraction < 3
    || cursorNear();
}
// She follows the cursor with her eyes and head, so a pointer moving near her has to be smooth.
// Only near her, though: waking on any mouse movement anywhere would keep her at full rate all day.
function cursorNear() {
  if (!cursor.seen) return false;
  if (performance.now() / 1000 - cursor.lastT > 1.2) return false;   // pointer has settled
  const sp = toScreen(pet.x, pet.y);
  return Math.hypot(cursor.sx - sp.x, cursor.sy - (sp.y - sizePx * 0.5)) < sizePx * 1.15;
}
function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = (now - lastFrame) / 1000;
  if (!model || paused) { lastFrame = now; return; }
  calmFor = busy() ? 0 : calmFor + elapsed;
  const target = 1 / (calmFor > CALM_AFTER ? FPS_CALM : FPS_ACTIVE);
  // a little tolerance, so a 60 cap on a 60Hz panel does not land just short and drop every other frame
  if (elapsed < target * 0.92) return;   // lastFrame is left alone, so dt accumulates properly
  lastFrame = now;
  const dt = clamp(elapsed, 1 / 240, 1 / 20);
  drawnFrames++;
  step(dt);
  draw();
}
window.__petDraws = () => drawnFrames;
window.__petFrameRate = () => ({ calmFor: +calmFor.toFixed(2), busy: busy(), cap: calmFor > CALM_AFTER ? FPS_CALM : FPS_ACTIVE });
requestAnimationFrame(frame);

// ---------------------------------------------------------------- dev/test hooks
window.__petInfo = () => {
  const sp = toScreen(pet.x, pet.y);
  return {
    state: pet.state, x: pet.x, y: pet.y, theta: pet.theta, onGround: pet.onGround,
    screenX: sp.x, screenY: sp.y, heightPx: sizePx, model: model && model.name, hit: cursor.hit,
    relay: relayStatus, relayInfo, relayTrades, tradesSeen: tradesSeenText(),
  };
};
window.__pet = pet;
window.__petReact = reactToTrade;
window.__petFx = { glow: addGlow, hurt: addHurt, heal: healHurt };
window.__petRelayMsg = (m) => handleRelay(m);
window.__petSign = () => (sign ? { phase: sign.phase, id: sign.id, visible: sign.mesh.visible, text: sign.text, content: signContent() } : { phase: 'none', content: signContent() });
window.__petPositions = () => [...positions.values()];
window.__petSignClose = () => signCloseAt();
window.__petDemoSign = () => toggleDemoSign();
window.__petGripTune = (axis, amt, roll) => { GRIP_TUNE = { axis, amt, roll: roll || 0 }; };
window.__petHandScreen = () => { if (!sign || !model) return null; const b = model.bones[(sign.side < 0 ? 'right' : 'left') + 'Hand']; if (!b) return null; const v = new THREE.Vector3(); b.getWorldPosition(v); v.project(camera); return { x: canvasLeft + (v.x + 1) / 2 * CS, y: canvasTop + (1 - v.y) / 2 * CS }; };
window.__petPoseTarget = poseTarget;
window.__petSignPose = (p) => { if (sign) sign.pose = p; };
window.__petSignTwo = (v) => { if (sign) { sign.two = v; sign.text = ''; } };
window.__petTwoGrip = (amt, roll) => { TWO_GRIP = { amt, roll }; if (sign) sign.text = ''; };
window.__petSadTune = (ua, la, hd) => { SAD_TUNE = { ua, la, hd }; };
window.__petPhoneTune = (ua, la, hd, head) => { PHONE_TUNE = { ua, la, hd, head: head ?? PHONE_TUNE.head }; };
window.__petTwoTune = (ua, la, hd, bottom, fwd) => { HOLD_TWO = { ua, la, hd }; if (bottom != null) TWO_BOTTOM = bottom; if (fwd != null) TWO_FWD = fwd; };
window.__petBustFront = () => { if (!model) return null; const v = new THREE.Vector3(); let maxZ = -9; for (const n of ['J_Sec_L_Bust2', 'J_Sec_R_Bust2', 'J_Sec_L_Bust1', 'J_Sec_R_Bust1']) { const b = model.vrm.scene.getObjectByName(n); if (!b) continue; b.getWorldPosition(v); maxZ = Math.max(maxZ, v.z); } return { bustTipZ: +(maxZ / model.height).toFixed(3), bustScale: model.bust.nodes[0] ? +model.bust.nodes[0].scale.x.toFixed(2) : 0 }; };
window.__petTorsoFront = () => { if (!model) return null; const v = new THREE.Vector3(); let maxZ = -9, at = 0; model.vrm.scene.traverse((o) => { if (!o.isSkinnedMesh && !o.isMesh) return; const p = o.geometry && o.geometry.attributes.position; if (!p) return; for (let i = 0; i < p.count; i += 5) { v.fromBufferAttribute(p, i); o.localToWorld(v); const ay = (v.y - pet.y) / model.height; if (ay < 0.45 || ay > 0.92) continue; if (v.z > maxZ) { maxZ = v.z; at = ay; } } }); return { frontZ: +(maxZ / model.height).toFixed(3), atHeight: +at.toFixed(2) }; };
window.__petTwoBoard = () => (sign ? { bottom: TWO_BOTTOM, fwd: TWO_FWD, halfW: 0.46 * 0.85 * 0.5, h: 0.35 * 0.85 } : null);
// Apply figure settings from a test harness WITHOUT saving them. An earlier version of this hook
// went through saveCfg, which persists — so every extreme pose captured for a screenshot was
// written straight into the user's own settings file.
window.__petSetCfg = (patch) => {
  if (!cfg) return;
  Object.assign(cfg, patch);
  applyFigure(); applyFigureTextures();
};
window.__petCfgAll = () => (cfg ? { hips: cfg.hips, waist: cfg.waist, bodyWeight: cfg.bodyWeight, thighs: cfg.thighs, bodyHeight: cfg.bodyHeight, shoulders: cfg.shoulders, arms: cfg.arms, headSize: cfg.headSize } : null);
window.__petLiveCfg = () => (cfg ? { topStyle: cfg.topStyle, bottomStyle: cfg.bottomStyle, outfit: cfg.outfit, cleavage: cfg.cleavage, bust: cfg.bust } : null);
window.__petCfgHold = () => (cfg ? cfg.signHold : null);
window.__petSignTwoState = () => (sign ? sign.two : null);
window.__petCfgSize = () => (cfg ? cfg.signSize : null);
window.__petCfgStyle = () => (cfg ? cfg.signStyle : 0);
window.__petAmpTest = (f) => { const m = model, b = m.bust; const tip = m.vrm.scene.getObjectByName("J_Sec_L_Bust2"); const v = new THREE.Vector3(); tip.getWorldPosition(v); const before = v.clone(); const saved = b.nodes.map((n) => n.quaternion.clone()); const g = BOUNCE_GAIN; BOUNCE_GAIN = f; amplifyBust(1 / 60); BOUNCE_GAIN = g; tip.getWorldPosition(v); const after = v.clone(); const moved = before.distanceTo(after) / m.height; b.nodes.forEach((n, i) => n.quaternion.copy(saved[i])); return { movedPctOfHeight: +(moved * 100).toFixed(3), deflectionDeg: +(2 * Math.acos(Math.min(1, Math.abs(b.rest[0].clone().invert().multiply(saved[0]).w))) * 57.2958).toFixed(1) }; };
window.__petGain = () => BOUNCE_GAIN;
window.__petSpringTune = (k, d, g, mx) => { SPRING_TUNE = { k, d }; if (g != null) BOUNCE_GAIN = g; if (mx != null) BOUNCE_MAX = mx; applyFigure(); };
window.__petLiveMints = () => [...liveMints];
window.__petOpenCount = () => [...positions.values()].filter((p) => p.tokens > 0 && p.live).length;
window.__petSignZ = () => (sign && model ? sign.mesh.position.z / model.height : null);
window.__petHandsPx = () => { if (!model) return null; const o = {}; for (const side of ['right','left']) { const b = model.bones[side+'MiddleProximal']; if (!b) continue; const v = new THREE.Vector3(); b.getWorldPosition(v); v.project(camera); o[side] = { x: canvasLeft + (v.x+1)/2*CS, y: canvasTop + (1-v.y)/2*CS }; } return o; };
window.__petHandsScreen = () => { if (!model) return null; const out = {}; for (const side of ['right', 'left']) { const b = model.bones[side + 'MiddleProximal']; if (!b) continue; const v = new THREE.Vector3(); b.getWorldPosition(v); out[side] = { wx: v.x, wy: v.y, wz: v.z, ax: (v.x - pet.x) / model.height, ay: (v.y - pet.y) / model.height }; } return out; };
window.__petSignStyles = () => SIGN_STYLES.map((x) => x.label);
window.__petSetStyle = (i) => { saveCfg({ signStyle: i }); if (sign) sign.text = ''; };
window.__petSignDismiss = () => dismissSign();
window.__petSignHover = (v) => { if (sign) sign.hover = v; };
window.__petBounds = () => ({ min: minX, max: maxX });
window.__petSignScreen = () => { const b = signScreenBox(); return b && { ...b, W, H, side: sign.side }; };
window.__petSignMesh = () => { const g = sign.mesh.geometry.parameters; return { y: sign.mesh.position.y, h: g.height * sign.mesh.scale.y, w: g.width * sign.mesh.scale.x }; };
window.__petSession = () => ({ pnl: sessionPnl, trades: sessionTrades });
window.__petModel = () => model;
window.__petPanel = (open) => (open === undefined ? togglePanel() : open ? openPanel() : closePanel());
window.__petToScreenV = (v) => projFx(v);
window.__petBonePx = (n) => bonePx(n);
window.__petPaintMs = () => ({ ...paintMs });
window.__petWoundSheets = () => { const o = {}; for (const k of ['face', 'skin']) for (const f of (model && model.figure && model.figure[k] ? model.figure[k].list : [])) if (f.woundCanvas) o[k] = f.woundCanvas.toDataURL('image/png'); return o; };
window.__petWounds = () => pet.wounds.map((w) => ({ type: w.def.type, anchor: w.anchor === undefined ? 'pending' : w.anchor && { u: +w.anchor.u.toFixed(3), v: +w.anchor.v.toFixed(3), dr: w.anchor.dr.map((x) => +x.toFixed(2)), dd: w.anchor.dd.map((x) => +x.toFixed(2)) } }));
window.__petSay = say;
window.__petSetCfg = (p) => saveCfg(p);
window.__petSleepNow = () => { pet.lastInteraction = T - SLEEP_AFTER - 30; lastTradeAt = T - SLEEP_AFTER - 30; if (pet.state !== 'sleep') setState('idle'); pet.micro = null; pet.nextActionAt = T + 999; };
window.__petSignList = (on) => { signListMode = on === undefined ? !signListMode : !!on; if (sign) sign.text = ''; };
window.__petScorecard = () => showScorecard(dayStats(), 'TODAY');
window.__petCelebrate = (t) => celebrate(t || 'Test!');
window.__petMood = (v) => (v === undefined ? pet.mood : (pet.mood = v));
window.__petFlinch = () => { pet.flinchAt = T; };
window.__petBadges = () => (sign ? signBadges(signContent()).map((b) => b.key) : []);
window.__petBadgeClick = (k) => signBadgeAction(k);
window.__petStats = () => (cfg ? { stats: cfg.stats, yesterday: cfg.yesterday, totalTrades: cfg.totalTrades, milestones: cfg.milestones } : null);
window.__petConfetti = () => sparks.filter((s) => s.confetti).length;
window.__petTour = {
  start: startTour,
  state: () => ({ active: tourActive, step: tourStep >= 0 ? TOUR[tourStep].key : null, visible: !!tourEl && !tourEl.hidden }),
  name: (n) => { const i = tourEl && tourEl.querySelector('#tourName'); if (i) { i.value = n; i.onkeydown({ key: 'Enter' }); } },
  next: () => { const b = tourEl && tourEl.querySelector('#tourNext'); if (b) b.click(); },
  skip: () => { const b = tourEl && tourEl.querySelector('#tourSkip'); if (b) b.click(); },
  box: () => { if (!tourEl || tourEl.hidden) return null; const r = tourEl.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; },
};
window.__petBubbleText = () => (bubbleEl ? bubbleEl.textContent : '');
window.__petReset = () => bridge.resetSettings();
// The website puts her wallet field and her demo buttons on the page itself rather than making a
// visitor hunt through her panel, so it needs to drive the relay and the panel from outside. The
// desktop app never calls these; they exist so the web build needs no fork of the renderer.
window.__petRelay = {
  connect: connectRelay,
  disconnect: disconnectRelay,
  status: () => ({ status: relayStatus, info: relayInfo, trades: relayTrades, connected: !!relay }),
};
window.__petPanelTab = (t) => { panelTab = t; if (panelOpen) { renderPanel(); positionPanel(); } };
window.__petRepanel = () => { if (panelOpen) { renderPanel(); positionPanel(); } };
// deterministic stepping for the self-test: advance `sec` seconds at 60 Hz, then draw
window.__petAdvance = (sec) => new Promise((resolve) => {
  if (!model) return resolve();
  paused = true;
  const n = Math.max(1, Math.round(sec * 60));
  for (let i = 0; i < n; i++) step(1 / 60);
  draw();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});
window.__petResume = () => { paused = false; lastFrame = performance.now(); };
// synchronous synthetic mouse input for the self-test
window.__petMouse = (type, x, y, button = 0) => {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button, buttons: type === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true }));
};

// plain-browser dev mode: load a model from ./models via fetch
if (!window.pet) {
  const file = new URLSearchParams(location.search).get('model') || 'models/seed-san.vrm';
  fetch(file).then((r) => r.arrayBuffer()).then((b) => loadModel(b, file.split('/').pop()));
  layout();
}
