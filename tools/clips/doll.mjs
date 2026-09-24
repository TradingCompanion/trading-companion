import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const doll = new FBXLoader().parse(ab, ''); doll.updateMatrixWorld(true);
let skinned = null; doll.traverse(o => { if (o.isSkinnedMesh && !skinned) skinned = o; });
console.log('children', doll.children.map(c => c.name + ':' + c.type).join(' | '), 'skinned', skinned && skinned.name, 'bones', skinned && skinned.skeleton.bones.length);
const sk = skinned.skeleton; const e = new THREE.Euler(); const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
const W = {}; for (let i = 0; i < sk.bones.length; i++) { const m = new THREE.Matrix4().copy(sk.boneInverses[i]).invert(); m.decompose(p, q, s); W[sk.bones[i].name] = { p: p.clone(), q: q.clone(), parent: sk.bones[i].parent?.name }; }
for (const name of ['root','Hips','Spine','Chest','Upper_Chest','Neck','Head','Shoulder_L','Upper_Arm_L','Lower_Arm_L','Hand_L','Middle_Proximal_L','Upper_Arm_R','Lower_Arm_R','Hand_R','Upper_Leg_L','Lower_Leg_L','Foot_L','Toes_L']) {
  const w = W[name]; if (!w) { console.log(name, 'MISSING'); continue; }
  e.setFromQuaternion(w.q); const node = sk.bones.find(b => b.name === name); node.getWorldQuaternion(q); const e2 = new THREE.Euler().setFromQuaternion(q); node.getWorldPosition(p);
  console.log(name.padEnd(18), 'par', String(w.parent).padEnd(14), 'bindEul', [e.x,e.y,e.z].map(v=>(v*180/Math.PI).toFixed(1)).join(','), 'bindPos', w.p.toArray().map(v=>v.toFixed(1)).join(','), '| nodeWorldEul', [e2.x,e2.y,e2.z].map(v=>(v*180/Math.PI).toFixed(1)).join(','), 'nodePos', p.toArray().map(v=>v.toFixed(1)).join(','));
}
// arm direction check
const d = (a, b) => new THREE.Vector3().subVectors(W[b].p, W[a].p).normalize().toArray().map(v => v.toFixed(2)).join(',');
console.log('dir UpperArm_L→LowerArm_L', d('Upper_Arm_L','Lower_Arm_L'), ' LowerArm_L→Hand_L', d('Lower_Arm_L','Hand_L'), ' UpperLeg_L→LowerLeg_L', d('Upper_Leg_L','Lower_Leg_L'), ' Hips→Head', d('Hips','Head'), ' Foot_L→Toes_L', d('Foot_L','Toes_L'));
console.log('all bone names:', sk.bones.map(b => b.name).join(','));
