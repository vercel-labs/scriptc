"use strict";
// byteLength and length of typed arrays, DataViews and Buffers read from
// dynamic code: element sizes, subarray views, a DataView's missing
// length, and a view that also carries its own named properties.
function sizes(view) {
  return view.byteLength + "/" + view.length;
}
const buffer = new ArrayBuffer(16);
const views = [
  new Uint8Array(4096),
  new Uint8Array(4096).subarray(100),
  new Uint16Array(3),
  new Float64Array(buffer),
  new Int32Array(buffer, 4, 2),
  new DataView(buffer, 2),
  Buffer.from("héllo"),
  new Uint8Array(0),
];
for (const v of views) console.log(sizes(v));
function label(view, text) {
  view.label = text;
  return view;
}
const named = label(new Uint8Array(8), "named");
console.log(sizes(named), named.label);
let total = 0;
for (let i = 0; i < 1000; i++) total += views[i % views.length].byteLength;
console.log(total);
