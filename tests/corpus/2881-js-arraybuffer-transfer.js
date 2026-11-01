"use strict";
// ArrayBuffer.prototype.transfer / transferToFixedLength and detachment
// (t262-dc C1): the transferred buffer keeps its bytes, every view of the old
// buffer becomes detached, and each guarded operation reports the detached
// error Node reports.
const b = new ArrayBuffer(8);
const u8 = new Uint8Array(b);
const dv = new DataView(b, 2);
u8[0] = 7;
const t = b.transfer();
console.log(b.detached, b.byteLength, t.byteLength, new Uint8Array(t)[0]);
console.log(u8.length, u8.byteLength, u8.byteOffset, u8[0]);
try { console.log(dv.byteLength); } catch (e) { console.log(e.constructor.name, e.message); }
u8[0] = 9;
console.log(u8[0], new Uint8Array(t)[0]);
try { b.slice(0); } catch (e) { console.log(e.constructor.name, e.message); }
try { dv.getUint8(0); } catch (e) { console.log(e.constructor.name, e.message); }
try { u8.fill(1); console.log("fill ok", u8.length); } catch (e) { console.log(e.constructor.name, e.message); }
const g = t.transferToFixedLength(4);
console.log(t.detached, g.byteLength, g.resizable, new Uint8Array(g)[0]);
let n = 0;
const big = new Uint8Array(new ArrayBuffer(4));
for (let i = 0; i < big.length; i++) { if (i === 1) big.buffer.transfer(); n++; }
console.log("loop", n, big.length);
// A Buffer pool slab's ArrayBuffer is not detachable.
const pooled = Buffer.allocUnsafe(2).buffer;
try { pooled.transfer(4); } catch (e) { console.log(e.constructor.name, e.message); }
try { pooled.transferToFixedLength(4); } catch (e) { console.log(e.constructor.name, e.message); }
// set() answers a detached source before it answers an out-of-range offset.
const gone = new Uint8Array(new ArrayBuffer(4));
gone.buffer.transfer();
try { new Uint8Array(4).set(gone); } catch (e) { console.log(e.constructor.name, e.message); }
try { new Uint8Array(4).set(gone, 100); } catch (e) { console.log(e.constructor.name, e.message); }
const target = new Uint8Array(4);
target.set([1, 2]);
console.log(target[0], target[1], target[3]);
