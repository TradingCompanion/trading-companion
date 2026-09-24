import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
const file = process.argv[2];
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new FBXLoader();
const obj = loader.parse(ab, '');
obj.updateMatrixWorld(true);
const bones = [];
obj.traverse(o => { if (o.isBone || o.type === 'Bone') bones.push(o); });
console.log('objects:', obj.children.map(c => c.name + ':' + c.type).join(', '));
console.log('bones:', bones.length);
const e = new THREE.Euler(); const q = new THREE.Quaternion(); const p = new THREE.Vector3();
for (const b of bones.slice(0, 60)) {
  b.getWorldQuaternion(q); e.setFromQuaternion(q); b.getWorldPosition(p);
  console.log(b.name.padEnd(24), 'parent=' + (b.parent?.name||'').padEnd(20), 'localEul', b.rotation.toArray().slice(0,3).map(v=>(v*180/Math.PI).toFixed(1)).join(','), ' worldEul', [e.x,e.y,e.z].map(v=>(v*180/Math.PI).toFixed(1)).join(','), ' wpos', p.toArray().map(v=>v.toFixed(2)).join(','), ' scale', b.scale.x.toFixed(3));
}
console.log('animations:', obj.animations.map(a => `${a.name} dur=${a.duration.toFixed(2)} tracks=${a.tracks.length}`));
if (obj.animations[0]) {
  const a = obj.animations[0];
  const kinds = {}; for (const t of a.tracks) { const k = t.name.split('.').pop(); kinds[k] = (kinds[k]||0)+1; }
  console.log('track kinds', kinds, 'sample', a.tracks.slice(0,3).map(t => t.name + ' n=' + t.times.length));
  const hips = a.tracks.find(t => /Hips\.position/.test(t.name)); if (hips) console.log('hips pos first/last', Array.from(hips.values.slice(0,3)), Array.from(hips.values.slice(-3)));
}
