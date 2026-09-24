import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
const dir = process.argv[2];
for (const f of fs.readdirSync(dir).filter(f => /\.fbx$/i.test(f))) {
  const buf = fs.readFileSync(dir + '/' + f); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const obj = new FBXLoader().parse(ab, '');
  const a = obj.animations[0];
  const fps = a ? Math.round((a.tracks[0].times.length - 1) / a.duration) : 0;
  const rp = a && a.tracks.find(t => t.name === 'root.position'), hp = a && a.tracks.find(t => t.name === 'Hips.position'), hq = a && a.tracks.find(t => t.name === 'Hips.quaternion');
  const d = (t) => t ? [0,1,2].map(i => +(t.values[t.values.length-3+i] - t.values[i]).toFixed(2)) : null;
  const hipsFirst = hp ? Array.from(hp.values.slice(0,3)).map(v=>+v.toFixed(2)) : null;
  // first-frame local rotation of a few bones (deg) to compare with the doll bind pose
  const eul = (n) => { const t = a.tracks.find(t => t.name === n + '.quaternion'); if (!t) return null; const q = new THREE.Quaternion().fromArray(t.values, 0); const e = new THREE.Euler().setFromQuaternion(q); return [e.x,e.y,e.z].map(v=>+(v*180/Math.PI).toFixed(1)); };
  const bones = []; obj.traverse(o => { if (o.isBone) bones.push(o.name); });
  console.log(f.padEnd(32), a ? `dur=${a.duration.toFixed(2)} fps≈${fps} frames=${a.tracks[0].times.length}` : 'NO ANIM', 'rootΔ', d(rp), 'hipsΔ', d(hp), 'hips0', hipsFirst, 'UpperArm_L f0', eul('Upper_Arm_L'), 'Hips f0', eul('Hips'), 'bones', bones.length);
}
// doll bind pose
const buf = fs.readFileSync(dir + '/DummyDoll.FBX'); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const doll = new FBXLoader().parse(ab, ''); doll.updateMatrixWorld(true);
let skinned = null; doll.traverse(o => { if (o.isSkinnedMesh && !skinned) skinned = o; });
console.log('doll children', doll.children.map(c => c.name + ':' + c.type), 'skinned', skinned && skinned.name, 'bones', skinned && skinned.skeleton.bones.length, 'anims', doll.animations.length);
if (skinned) {
  const sk = skinned.skeleton; const e = new THREE.Euler(); const p = new THREE.Vector3(); const q = new THREE.Quaternion();
  // bind pose from inverse bind matrices (world), and current node local rotations
  for (const name of ['Hips','Spine','Chest','Upper_Chest','Neck','Head','Shoulder_L','Upper_Arm_L','Lower_Arm_L','Hand_L','Upper_Leg_L','Lower_Leg_L','Foot_L','Toes_L']) {
    const i = sk.bones.findIndex(b => b.name === name); if (i < 0) { console.log(name, 'MISSING'); continue; }
    const m = new THREE.Matrix4().copy(sk.boneInverses[i]).invert(); const s = new THREE.Vector3(); m.decompose(p, q, s); e.setFromQuaternion(q);
    const b = sk.bones[i]; const le = b.rotation;
    console.log(name.padEnd(14), 'bindWorldEul', [e.x,e.y,e.z].map(v=>(v*180/Math.PI).toFixed(1)).join(','), 'bindWorldPos', p.toArray().map(v=>v.toFixed(1)).join(','), ' nodeLocalEul', [le.x,le.y,le.z].map(v=>(v*180/Math.PI).toFixed(1)).join(','));
  }
}
