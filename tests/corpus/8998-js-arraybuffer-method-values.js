"use strict";
// ArrayBuffer / SharedArrayBuffer prototype method values (t262-dc2): a
// program with the mutable-buffers fact reaches the methods as values, so
// `typeof ab.transfer` is "function", `const f = ab.transfer` is the shared
// prototype value, `f.call(ab, 8)` runs it on that receiver, and `in` answers
// the methods and the getter names.
const ab = new ArrayBuffer(8, { maxByteLength: 16 });
console.log(typeof ab.slice, typeof ab.resize, typeof ab.transfer, typeof ab.transferToFixedLength);
console.log(ab.slice.length, ab.resize.length, ab.transfer.length, ab.transferToFixedLength.length);
const transfer = ab.transfer;
console.log(typeof transfer, transfer.name);
console.log(transfer === ab.transfer, ab.transfer === new ArrayBuffer(4).transfer);
const moved = transfer.call(ab, 4);
console.log(moved.byteLength, ab.detached, ab.byteLength, ab.resizable);
const resized = new ArrayBuffer(2, { maxByteLength: 4 });
resized.resize(4);
console.log(resized.byteLength, resized.maxByteLength, resized.detached);
console.log("slice" in ab, "resize" in ab, "transfer" in ab, "transferToFixedLength" in ab);
console.log("resizable" in ab, "maxByteLength" in ab, "byteLength" in ab, "detached" in ab);
console.log("growable" in ab, "grow" in ab, "nothing" in ab);
const sab = new SharedArrayBuffer(4, { maxByteLength: 8 });
const plain = new SharedArrayBuffer(4);
console.log(typeof sab.slice, typeof sab.grow, sab.slice.length, sab.grow.length);
console.log(sab.growable, plain.growable, new SharedArrayBuffer(4, {}).growable);
console.log("grow" in sab, "growable" in sab, "resize" in sab, "transfer" in sab, "detached" in sab);
sab.grow(8);
console.log(sab.byteLength, sab.growable, sab.slice().byteLength);
