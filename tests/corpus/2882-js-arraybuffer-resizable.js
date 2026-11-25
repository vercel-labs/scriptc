"use strict";
// Resizable and growable buffers (t262-dc C2): maxByteLength is reserved up
// front, so resizing never moves storage; every view's length follows the
// owner, and an out-of-bounds view reads as detached.
const rab = new ArrayBuffer(4, { maxByteLength: 8 });
const track = new Uint8Array(rab);
const fixed = new Uint8Array(rab, 2, 2);
console.log(rab.resizable, rab.maxByteLength, track.length, fixed.length);
track[3] = 5;
rab.resize(8);
console.log(rab.byteLength, track.length, fixed.length, track[3], track[7]);
rab.resize(3);
console.log(track.length, fixed.length, fixed.byteOffset, fixed[0]);
rab.resize(6);
console.log(track.length, fixed.length, fixed[1], track[3]);
try { rab.resize(9); } catch (e) { console.log(e.constructor.name, e.message); }
const sab = new SharedArrayBuffer(2, { maxByteLength: 4 });
sab.grow(4);
console.log(sab.growable, sab.byteLength, new Uint8Array(sab).length);
try { sab.grow(1); } catch (e) { console.log(e.constructor.name, e.message); }
let seen = 0;
const v = new Uint8Array(new ArrayBuffer(4, { maxByteLength: 4 }));
v.forEach((x, i) => { if (i === 0) v.buffer.resize(2); seen++; });
console.log("forEach", seen, v.length);
// Without maxByteLength a SharedArrayBuffer has a fixed length.
const fixedSab = new SharedArrayBuffer(2, {});
console.log(fixedSab.growable);
try { fixedSab.grow(4); } catch (e) { console.log(e.constructor.name, e.message); }
// map stores every callback result: its result array does not follow the
// source, and an index the shrunk source cannot read arrives as undefined.
const rabMap = new ArrayBuffer(4, { maxByteLength: 8 });
const trackMap = new Uint8Array(rabMap);
for (let i = 0; i < 4; i++) trackMap[i] = i + 1;
const mapped = trackMap.map((x, i) => { if (i === 1) rabMap.resize(2); return x * 10; });
console.log(mapped.length, mapped[0], mapped[1], mapped[2], mapped[3], trackMap.length);
const fbuf = new ArrayBuffer(32, { maxByteLength: 64 });
const fsrc = new Float64Array(fbuf);
fsrc[0] = 1; fsrc[1] = 2; fsrc[2] = 3; fsrc[3] = 4;
const fmapped = fsrc.map((x, i) => { if (i === 1) fbuf.resize(8); return x * 10; });
console.log(fmapped.length, fmapped[0], fmapped[1], fmapped[2] !== fmapped[2]);
// The same after the source detaches.
const detachMap = new Uint8Array(new ArrayBuffer(4));
detachMap[0] = 1; detachMap[1] = 2; detachMap[2] = 3; detachMap[3] = 4;
const detached = detachMap.map((x, i) => { if (i === 1) detachMap.buffer.transfer(); return x + 1; });
console.log(detached.length, detached[0], detached[1], detached[2], detached[3]);
