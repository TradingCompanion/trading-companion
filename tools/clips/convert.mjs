// FBX humanoid clip → Yui clip JSON (normalized VRM humanoid rotations).
//
// Source: KAWAII ANIMATIONS (Unity Humanoid FBX, Z-up, cm, forward -Y). The DummyDoll.FBX node
// transforms are the rig's T-pose; each clip FBX carries local rotation tracks on the same bones.
// Retarget per bone: q_vrm = G · Rw0(parent) · q_src(t) · Rw0(bone)⁻¹ · G⁻¹, where Rw0 is the
// T-pose world rotation and G converts the source frame to VRM 1.0 normalized space (Y-up, +Z
// forward). The normalized VRM rig has identity rest rotations, so that is the whole retarget.
// Hips translation is stored as an offset from the T-pose hips in units of hip height; the player
// scales it by the model's own hip height. Root-motion translation is stripped (in place) and
// reported as `speed` (hip heights per second) so the walk can move her at a matching pace.
//
// usage: node tools/clips/convert.mjs <fbxDir> <outDir>
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';

const [,, fbxDir, outDir] = process.argv;
if (!fbxDir || !outDir) { console.error('usage: convert.mjs <fbxDir> <outDir>'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const MAP = {
  Hips: 'hips', Spine: 'spine', Chest: 'chest', Upper_Chest: 'upperChest', Neck: 'neck', Head: 'head',
};
for (const [s, v] of [['L', 'left'], ['R', 'right']]) {
  Object.assign(MAP, {
    [`Shoulder_${s}`]: `${v}Shoulder`, [`Upper_Arm_${s}`]: `${v}UpperArm`, [`Lower_Arm_${s}`]: `${v}LowerArm`, [`Hand_${s}`]: `${v}Hand`,
    [`Upper_Leg_${s}`]: `${v}UpperLeg`, [`Lower_Leg_${s}`]: `${v}LowerLeg`, [`Foot_${s}`]: `${v}Foot`, [`Toes_${s}`]: `${v}Toes`,
    // Unity "Thumb Proximal/Intermediate/Distal" = VRM 1.0 thumbMetacarpal/Proximal/Distal
    [`Thumb_Proximal_${s}`]: `${v}ThumbMetacarpal`, [`Thumb_Intermediate_${s}`]: `${v}ThumbProximal`, [`Thumb_Distal_${s}`]: `${v}ThumbDistal`,
  });
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const j of ['Proximal', 'Intermediate', 'Distal']) MAP[`${f}_${j}_${s}`] = `${v}${f}${j}`;
}

function loadFbx(file) {
  const buf = fs.readFileSync(file);
  return new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
}
function nodes(obj) { const m = {}; obj.traverse((o) => { if (o.name) m[o.name] = o; }); return m; }

// ---- T-pose from the doll ------------------------------------------------------------------
const dollPath = process.env.DOLL || path.join(fbxDir, 'DummyDoll.FBX');
const doll = loadFbx(dollPath);
doll.updateMatrixWorld(true);
const dn = nodes(doll);
const Rw0 = {}, P0 = {};
for (const n in dn) { Rw0[n] = dn[n].getWorldQuaternion(new THREE.Quaternion()); P0[n] = dn[n].getWorldPosition(new THREE.Vector3()); }
const HIP_H = P0.Hips.z; // cm; the floor is z=0
const G = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); // Z-up/-Y-fwd → Y-up/+Z-fwd
const Gi = G.clone().invert();
{ // sanity: after G the T-pose must have arms along ±X, spine up +Y, toes toward +Z
  const dir = (a, b) => new THREE.Vector3().subVectors(P0[b], P0[a]).normalize().applyQuaternion(G);
  const chk = { armL: dir('Upper_Arm_L', 'Lower_Arm_L'), armR: dir('Upper_Arm_R', 'Lower_Arm_R'), spine: dir('Hips', 'Head'), toes: dir('Foot_L', 'Toes_L'), leg: dir('Upper_Leg_L', 'Lower_Leg_L') };
  const ok = chk.armL.x > 0.98 && chk.armR.x < -0.98 && chk.spine.y > 0.98 && chk.toes.z > 0.8 && chk.leg.y < -0.98;
  console.log('T-pose check', ok ? 'OK' : 'FAILED', Object.fromEntries(Object.entries(chk).map(([k, v]) => [k, v.toArray().map((x) => +x.toFixed(2))])));
  if (!ok) process.exit(2);
}

// ---- clips ---------------------------------------------------------------------------------
// every clip under fbxDir, recursively; the output name keeps the folder (Idle/Idle01_breathing)
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) walk(q); else if (/^@?KA_.*\.fbx$/i.test(f)) files.push(path.relative(fbxDir, q)); } })(fbxDir);
files.sort();
const _q = new THREE.Quaternion(), _p = new THREE.Vector3();
for (const f of files) {
  const obj = loadFbx(path.join(fbxDir, f));
  const anim = obj.animations[0];
  if (!anim) { console.log(f, 'no animation'); continue; }
  const cn = nodes(obj);
  const times = anim.tracks[0].times;
  const frames = times.length, fps = Math.round((frames - 1) / anim.duration);
  const trk = {}; for (const t of anim.tracks) trk[t.name] = t;
  const name = f.replace(/\\/g, '/').replace(/(^|\/)@?KA_/, '$1').replace(/\.fbx$/i, '');
  if (fs.existsSync(path.join(outDir, name + '.json')) && process.env.SKIP_EXISTING) continue;
  const out = { name, fps, frames, duration: +anim.duration.toFixed(4), speed: 0, bones: {}, hips: [] };
  // root motion: translation of the root over the clip (source cm, forward is -Y)
  const rp = trk['root.position'];
  if (rp) { const d = new THREE.Vector3(rp.values[rp.values.length - 3] - rp.values[0], rp.values[rp.values.length - 2] - rp.values[1], rp.values[rp.values.length - 1] - rp.values[2]); out.speed = +((-d.y / HIP_H) / anim.duration).toFixed(4); out.rootDrift = d.toArray().map((x) => +x.toFixed(1)); }
  const rq = trk['root.quaternion'];
  if (rq) { let maxA = 0; for (let i = 0; i < frames; i++) { _q.fromArray(rq.values, i * 4); maxA = Math.max(maxA, 2 * Math.acos(Math.min(1, Math.abs(_q.w)))); } if (maxA > 0.02) console.log(`  ! ${name}: root rotates up to ${(maxA * 180 / Math.PI).toFixed(1)}° — stripped`); }
  // per bone
  const missing = [];
  for (const src in MAP) {
    const t = trk[src + '.quaternion'];
    if (!t || !cn[src]) { missing.push(src); continue; }
    const parent = cn[src].parent.name;
    const pre = new THREE.Quaternion().copy(G).multiply(Rw0[parent]);
    const post = new THREE.Quaternion().copy(Rw0[src]).invert().multiply(Gi);
    const arr = new Array(frames * 4);
    let prev = null;
    for (let i = 0; i < frames; i++) {
      _q.fromArray(t.values, i * 4);
      _q.premultiply(pre).multiply(post).normalize();
      if (prev && _q.dot(prev) < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; } // keep the shortest arc between frames
      prev = _q.clone();
      arr[i * 4] = +_q.x.toFixed(5); arr[i * 4 + 1] = +_q.y.toFixed(5); arr[i * 4 + 2] = +_q.z.toFixed(5); arr[i * 4 + 3] = +_q.w.toFixed(5);
    }
    out.bones[MAP[src]] = arr;
  }
  // hips offset from the T-pose hips, in hip heights, converted frame. The track is local to the
  // root bone, whose motion is never applied — so this is already in place.
  const hp = trk['Hips.position'];
  for (let i = 0; i < frames; i++) {
    _p.fromArray(hp.values, i * 3);
    _p.sub(P0.Hips).applyQuaternion(G).divideScalar(HIP_H);
    out.hips.push(+_p.x.toFixed(4), +_p.y.toFixed(4), +_p.z.toFixed(4));
  }
  // ---- self-check: rebuild world directions in the normalized rig and compare with the source
  {
    const W = {}; // world rotation in the normalized rig
    const order = []; obj.traverse((o) => { if (MAP[o.name]) order.push(o.name); });
    let worst = 0, worstBone = '';
    for (let i = 0; i < frames; i += Math.max(1, Math.floor(frames / 8))) {
      // pose the source skeleton at frame i
      for (const n in cn) { const tq = trk[n + '.quaternion'], tp = trk[n + '.position']; if (tq) cn[n].quaternion.fromArray(tq.values, i * 4); if (tp) cn[n].position.fromArray(tp.values, i * 3); }
      obj.updateMatrixWorld(true);
      for (const n of order) {
        const parent = cn[n].parent.name;
        const local = new THREE.Quaternion().fromArray(out.bones[MAP[n]], i * 4);
        W[n] = (W[parent] ? W[parent].clone() : new THREE.Quaternion()).multiply(local);
        const child = cn[n].children.find((c) => MAP[c.name]);
        if (!child) continue;
        const restDir = new THREE.Vector3().subVectors(P0[child.name], P0[n]).normalize().applyQuaternion(G);
        const got = restDir.applyQuaternion(W[n]);
        const want = new THREE.Vector3().subVectors(child.getWorldPosition(new THREE.Vector3()), cn[n].getWorldPosition(new THREE.Vector3())).normalize().applyQuaternion(G);
        const err = got.angleTo(want) * 180 / Math.PI;
        if (err > worst) { worst = err; worstBone = n + '@' + i; }
      }
    }
    out.check = +worst.toFixed(3);
    console.log(`${name.padEnd(22)} ${frames}f @${fps} ${anim.duration.toFixed(2)}s speed=${out.speed} hipH/s  bones=${Object.keys(out.bones).length} missing=[${missing.join(',')}]  worst dir error ${worst.toFixed(3)}° (${worstBone})`);
  }
  fs.mkdirSync(path.dirname(path.join(outDir, name + '.json')), { recursive: true });
  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(out));
}
console.log('hip height (cm):', HIP_H.toFixed(1));
