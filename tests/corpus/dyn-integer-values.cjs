"use strict";
// Numbers produced by dynamic code around the shared integer nodes'
// bounds: equality, Object.is (-0), arithmetic and stores keep their values.
function box(x) {
  return { v: x };
}
const values = [-129, -128, -1, -0, 0, 1, 255, 256, 257, 300.5, 4095, 4096, 4097, 2 ** 31, NaN];
console.log(values.map((x) => box(x).v).join(","));
console.log(values.map((x) => Object.is(box(x).v, -0)).join(","));
const counter = box(250);
for (let i = 0; i < 4000; i++) counter.v = counter.v + 1;
console.log(counter.v, counter.v === 4250, box(4096).v === 4096, box(4096).v + 0.5);
const bytes = [];
for (let n = 254; n < 260; n++) bytes.push(new Uint8Array(n).byteLength);
console.log(bytes.join(","), String(box(4096).v), JSON.stringify(box(256)));
