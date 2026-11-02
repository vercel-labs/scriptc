"use strict";
// An ArrayBuffer's and a SharedArrayBuffer's prototype methods read as values
// through an untyped handle (t262-dc C3). The read answers one shared
// function per (class, method), as Node's prototype methods are shared, and
// calling it reaches the operation the member call reaches.

const ab = new ArrayBuffer(8, { maxByteLength: 16 });
const second = new ArrayBuffer(2);
const sab = new SharedArrayBuffer(4, { maxByteLength: 8 });

console.log(typeof ab.resize, ab.resize.name, ab.resize.length);
console.log(ab.slice.name, ab.slice.length, ab.transfer.length, ab.transferToFixedLength.length);
console.log(sab.slice.name, sab.slice.length, sab.grow.name, sab.grow.length);

// One function per (class, method), shared by every instance of the class.
console.log(ab.resize === second.resize, ab.slice === second.slice);
console.log(ab.transfer === ab.transfer, ab.slice === sab.slice);

// The members are visible to `in`, and the other class's are not.
console.log("resize" in ab, "transfer" in ab, "grow" in ab);
console.log("resize" in sab, "transfer" in sab, "slice" in sab);

// Called through the member, the value reaches the operation.
ab.resize(10);
console.log(ab.byteLength);
const copied = ab.slice(2, 6);
console.log(copied.byteLength, ab.byteLength);
sab.grow(6);
console.log(sab.byteLength, sab.growable);

// Called without its receiver, the method throws a TypeError.
const unbound = ab.resize;
try {
  unbound(2);
  console.log("no throw");
} catch (error) {
  console.log(error.name);
}
try {
  unbound.call(ab, 2);
  console.log(ab.byteLength);
} catch (error) {
  console.log(error.name);
}

// transfer answers a fresh buffer and detaches the original.
const moved = ab.transfer();
console.log(moved.byteLength, ab.byteLength, ab.detached);
