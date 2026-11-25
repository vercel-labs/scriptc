"use strict";
// A DataView's `constructor`, read through an untyped value (t262-dc C3). The
// answer is the interned DataView function value, which is the same object a
// JavaScript source reads for the global, so the identity test is exact.
// The resizable buffers are what select the object model build.
const rab = new ArrayBuffer(8, { maxByteLength: 16 });
const dv = new DataView(rab, 2);
const ctor = dv.constructor;
console.log(ctor === DataView, ctor.name, ctor.length, typeof ctor);
console.log(dv.constructor === ctor, ctor === ctor);
const sab = new SharedArrayBuffer(4, { maxByteLength: 8 });
const shared = new DataView(sab);
console.log(shared.constructor === DataView, shared.constructor === ctor);
