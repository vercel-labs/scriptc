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
