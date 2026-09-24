// Motion clips: plays converted humanoid animations (tools/clips/convert.mjs → clips/*.json) on the
// normalized VRM rig, under the procedural pose system.
//
// A clip is sampled every frame into a pose (bone → quaternion, plus a hips offset) and blended onto
// the bones *after* applyPose has written the procedural pose, with a weight that fades in and out,
// so a clip can take over her body and hand it back without a pop. Head and neck are additive: the
// clip's rotation times the procedural one, so she still looks at the cursor while a clip runs.
// VRM 0.x rigs face the other way (see model.sign in the renderer): their local X/Z flip.
import * as THREE from 'three';

const clips = new Map();     // name -> { name, fps, frames, duration, speed, bones: {vrm: Float32Array}, hips: Float32Array }
const loading = new Map();
let base = 'clips/';
export function setClipBase(b) { base = b; }
export function loadClip(name) {
  if (clips.has(name)) return Promise.resolve(clips.get(name));
  if (loading.has(name)) return loading.get(name);
  const p = fetch(base + name + '.json').then((r) => { if (!r.ok) throw new Error('clip ' + name + ': HTTP ' + r.status); return r.json(); })
    .then((d) => { for (const b in d.bones) d.bones[b] = Float32Array.from(d.bones[b]); d.hips = Float32Array.from(d.hips); clips.set(name, d); loading.delete(name); return d; })
    .catch((e) => { loading.delete(name); throw e; });
  loading.set(name, p);
  return p;
}
export function hasClip(name) { return clips.has(name); }
export function clipInfo(name) { return clips.get(name) || null; }

const ADDITIVE = new Set(['head', 'neck']);
let headAdditive = true;
export function setHeadAdditive(v) { headAdditive = !!v; }
const FINGERS = /^(left|right)(Thumb|Index|Middle|Ring|Little)/;

const L = {
  clip: null, want: null, t: 0, rate: 1, loop: true, ended: false, onEnd: null,
  w: 0, wTarget: 0, fade: 0.25,
  pose: new Map(), hips: new THREE.Vector3(),
  from: null, fromT: 0, fromDur: 0,   // the pose she was in when the clip changed, blended out
};
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

let onStart = null;
export function setOnStart(fn) { onStart = fn; }
export function current() { return L.clip ? L.clip.name : null; }
export function clipEnded() { return L.ended; }
export function clipTime() { return L.t; }
export function clipWeight() { return L.w; }

// Start (or keep) a clip. Not loaded yet: it starts as soon as it arrives, unless something else was
// asked for in the meantime.
export function play(name, opts = {}) {
  const { loop = true, rate = 1, fade = 0.25, onEnd = null, restart = false } = opts;
  L.want = name;
  if (L.clip && L.clip.name === name && !restart) { L.loop = loop; L.rate = rate; L.wTarget = 1; L.fade = fade; if (onEnd) L.onEnd = onEnd; return true; }
  const d = clips.get(name);
  if (!d) { loadClip(name).then(() => { if (L.want === name) play(name, opts); }).catch(() => {}); return false; }
  if (L.clip && L.w > 0.001) snapshotFrom(fade);
  L.clip = d; L.t = 0; L.rate = rate; L.loop = loop; L.ended = false; L.onEnd = onEnd; L.fade = fade; L.wTarget = 1;
  if (onStart) { try { onStart(name); } catch (e) { /* a voice is never worth a frame */ } }
  return true;
}
export function stop(fade = 0.25) { L.want = null; L.wTarget = 0; L.fade = fade; }
function snapshotFrom(dur) {
  const pose = new Map();
  for (const [n, q] of L.pose) pose.set(n, q.clone());
  L.from = { pose, hips: L.hips.clone(), w: L.w }; L.fromT = 0; L.fromDur = Math.max(0.05, dur);
}

export function update(dt) {
  if (!L.clip) { L.w = 0; return; }
  const c = L.clip;
  L.t += dt * L.rate;
  if (L.t >= c.duration) {
    if (L.loop) L.t %= c.duration;
    else { L.t = c.duration - 1e-4; if (!L.ended) { L.ended = true; if (L.onEnd) { const f = L.onEnd; L.onEnd = null; f(); } } }
  }
  // weight
  const step = dt / Math.max(0.01, L.fade);
  L.w = L.wTarget > L.w ? Math.min(L.wTarget, L.w + step) : Math.max(L.wTarget, L.w - step);
  if (L.w <= 0 && L.wTarget <= 0) { L.clip = null; L.from = null; L.pose.clear(); return; }
  // sample
  const f = L.t * c.fps;
  let i0 = Math.floor(f), a = f - i0;
  let i1 = i0 + 1;
  if (i1 >= c.frames) { if (L.loop) i1 = 0; else { i1 = c.frames - 1; a = 0; } }
  if (i0 >= c.frames) i0 = c.frames - 1;
  for (const b in c.bones) {
    const arr = c.bones[b];
    _q0.fromArray(arr, i0 * 4); _q1.fromArray(arr, i1 * 4);
    _q0.slerp(_q1, a);
    let q = L.pose.get(b); if (!q) { q = new THREE.Quaternion(); L.pose.set(b, q); }
    q.copy(_q0);
  }
  L.hips.set(
    c.hips[i0 * 3] + (c.hips[i1 * 3] - c.hips[i0 * 3]) * a,
    c.hips[i0 * 3 + 1] + (c.hips[i1 * 3 + 1] - c.hips[i0 * 3 + 1]) * a,
    c.hips[i0 * 3 + 2] + (c.hips[i1 * 3 + 2] - c.hips[i0 * 3 + 2]) * a);
  // blend out of the pose the previous clip left her in
  if (L.from) {
    L.fromT += dt;
    const m = smooth(L.fromT / L.fromDur);
    for (const [n, q] of L.pose) { const fq = L.from.pose.get(n); if (fq) q.copy(fq).slerp(q, m); }
    L.hips.lerpVectors(L.from.hips, L.hips, m);
    if (m >= 1) L.from = null;
  }
}
function smooth(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }

// Resolved bones per model — the normalized nodes, looked up by VRM 1.0 name so the thumb chain
// (metacarpal/proximal/distal) resolves on VRM 0.x models too.
let rig = null;
function rigFor(model) {
  if (rig && rig.vrm === model.vrm) return rig;
  const nodes = {};
  const hum = model.vrm.humanoid;
  const names = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
  for (const s of ['left', 'right']) {
    names.push(s + 'Shoulder', s + 'UpperArm', s + 'LowerArm', s + 'Hand', s + 'UpperLeg', s + 'LowerLeg', s + 'Foot', s + 'Toes', s + 'ThumbMetacarpal', s + 'ThumbProximal', s + 'ThumbDistal');
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const j of ['Proximal', 'Intermediate', 'Distal']) names.push(s + f + j);
  }
  for (const n of names) { const b = hum.getNormalizedBoneNode(n); if (b) nodes[n] = b; }
  rig = { vrm: model.vrm, nodes, hipsRest: nodes.hips ? nodes.hips.position.clone() : new THREE.Vector3() };
  return rig;
}

// Blend the sampled pose onto the rig. `skipHands` keeps hands and fingers procedural (she is
// holding something).
export function apply(model, skipHands = false) {
  if (!L.clip || L.w <= 0 || !model) return;
  const r = rigFor(model), sg = model.sign, w = L.w;
  for (const [n, q] of L.pose) {
    const node = r.nodes[n];
    if (!node) continue;
    if (skipHands && (FINGERS.test(n) || n === 'leftHand' || n === 'rightHand')) continue;
    _q.copy(q);
    if (sg < 0) _q.set(-_q.x, _q.y, -_q.z, _q.w);
    if (headAdditive && ADDITIVE.has(n)) _q.multiply(node.quaternion);
    node.quaternion.slerp(_q, w);
  }
  if (r.nodes.hips) {
    _v.copy(L.hips).multiplyScalar(model.hipH);
    if (sg < 0) { _v.x = -_v.x; _v.z = -_v.z; }
    r.nodes.hips.position.copy(r.hipsRest).addScaledVector(_v, w);
  }
}
export function resetRig() { rig = null; }
// How far the clip lifts her hips off the floor right now (world units): the view follows it so a
// jump does not go out of the top of her canvas.
export function lift(model) { return L.clip && L.w > 0 && model ? Math.max(0, L.hips.y) * model.hipH * L.w : 0; }

// ---- arms off the bust ------------------------------------------------------------------------
// The clips were animated on a flat doll; her bust is not flat. Three spheres (each breast, from
// the VRoid bust bones, and the sternum between them) push the upper arm outward whenever the
// elbow, forearm or hand lands inside one — a rotation about the shoulder, so the pose keeps its
// character and the hand just clears the chest. Runs only while a clip has weight.
const _S = new THREE.Vector3(), _P = new THREE.Vector3(), _V = new THREE.Vector3(), _D = new THREE.Vector3(), _AX = new THREE.Vector3();
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _M = new THREE.Vector3();
const _RW = new THREE.Quaternion(), _WP = new THREE.Quaternion(), _WPI = new THREE.Quaternion();
const spheres = [{ c: new THREE.Vector3(), r: 0 }, { c: new THREE.Vector3(), r: 0 }, { c: new THREE.Vector3(), r: 0 }];
export const bustDbg = { pushes: 0, maxAngle: 0, spheres };
function bustSpheres(model) {
  const sc = model.vrm.scene;
  const l1 = sc.getObjectByName('J_Sec_L_Bust1'), l2 = sc.getObjectByName('J_Sec_L_Bust2');
  const r1 = sc.getObjectByName('J_Sec_R_Bust1'), r2 = sc.getObjectByName('J_Sec_R_Bust2');
  if (!l1 || !l2 || !r1 || !r2) return 0;
  const pad = 0.012 * model.height;
  l1.getWorldPosition(_A); l2.getWorldPosition(_B);
  spheres[0].c.lerpVectors(_A, _B, 0.55); spheres[0].r = _A.distanceTo(_B) * 0.95 + pad;
  r1.getWorldPosition(_A); r2.getWorldPosition(_B);
  spheres[1].c.lerpVectors(_A, _B, 0.55); spheres[1].r = _A.distanceTo(_B) * 0.95 + pad;
  spheres[2].c.lerpVectors(spheres[0].c, spheres[1].c, 0.5); spheres[2].r = spheres[0].c.distanceTo(spheres[1].c) * 0.5 + pad * 0.5;
  return 3;
}
export function keepArmsOffBust(model) {
  if (!L.clip || L.w <= 0.01 || !model || !model.bust || !bustSpheres(model)) return;
  const r = rigFor(model);
  const root = model.vrm.humanoid.normalizedHumanBonesRoot;
  bustDbg.pushes = 0; bustDbg.maxAngle = 0;
  for (const side of ['left', 'right']) {
    const ua = r.nodes[side + 'UpperArm'], la = r.nodes[side + 'LowerArm'], hand = r.nodes[side + 'Hand'], mid = r.nodes[side + 'MiddleProximal'];
    if (!ua || !la || !hand) continue;
    // start from last frame's correction so the push does not restart from zero every frame (jitter)
    let corr = corrs[side]; if (!corr) corr = corrs[side] = new THREE.Quaternion();
    ua.quaternion.premultiply(corr);
    let hit = false, clear = false;
    for (let pass = 0; pass < 4; pass++) {
      root.updateMatrixWorld(true);
      ua.getWorldPosition(_S);
      let worst = 0, wi = -1;
      // the elbow, the forearm middle, the wrist, and the palm
      la.getWorldPosition(_A); hand.getWorldPosition(_B); _M.lerpVectors(_A, _B, 0.5);
      const pts = [_A, _M, _B];
      if (mid) { mid.getWorldPosition(_P); _P.sub(_B).multiplyScalar(1.6).add(_B); pts.push(_P); }
      let pt = null, sph = null, deepest = -Infinity;
      for (const p of pts) for (const s of spheres) { const d = s.r - p.distanceTo(s.c); if (d > deepest) deepest = d; if (d > worst) { worst = d; pt = p; sph = s; } }
      if (!pt) { clear = deepest < -0.01 * model.height; break; }
      _V.subVectors(pt, _S); const len = _V.length(); if (len < 1e-4) break;
      _D.subVectors(pt, sph.c); if (_D.lengthSq() < 1e-8) _D.set(side === 'left' ? 1 : -1, 0, 0); _D.normalize();
      _AX.crossVectors(_V, _D); if (_AX.lengthSq() < 1e-8) break; _AX.normalize();
      const ang = Math.min(0.3, (worst / len) * 1.05);
      _RW.setFromAxisAngle(_AX, ang);
      ua.parent.getWorldQuaternion(_WP); _WPI.copy(_WP).invert();
      _WPI.multiply(_RW).multiply(_WP);           // the same push, in the shoulder's local frame
      ua.quaternion.premultiply(_WPI); corr.premultiply(_WPI);
      hit = true; bustDbg.pushes++; bustDbg.maxAngle = Math.max(bustDbg.maxAngle, ang);
    }
    // well clear of the chest: let the correction relax back over a few frames
    if (!hit && clear) corr.slerp(IDENT, 0.1);
  }
}
const corrs = {};
const IDENT = new THREE.Quaternion();
