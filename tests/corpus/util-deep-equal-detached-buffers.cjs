"use strict";
// util.isDeepStrictEqual over ArrayBuffers compares the reported byte length
// first and then builds a Uint8Array over each buffer, so a detached buffer
// (which reports length 0) throws V8's construct error against another
// buffer that also reports 0, while a length mismatch answers false before
// any view is built. SharedArrayBuffers, records and views never reach the
// view step against an ArrayBuffer.
const { isDeepStrictEqual: equal } = require("node:util");

const detach = (bytes) => {
  const buffer = new ArrayBuffer(bytes);
  buffer.transfer();
  return buffer;
};

const attempt = (label, run) => {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, "threw", error.constructor.name, JSON.stringify(error.message), error.code);
  }
};

const live = new ArrayBuffer(2);
new Uint8Array(live)[0] = 1;
const twin = new ArrayBuffer(2);
new Uint8Array(twin)[0] = 1;
console.log("live pair", equal(live, twin));
new Uint8Array(twin)[0] = 2;
console.log("live bytes", equal(live, twin));
console.log("live lengths", equal(live, new ArrayBuffer(4)));

attempt("detached vs empty", () => equal(detach(2), new ArrayBuffer(0)));
attempt("empty vs detached", () => equal(new ArrayBuffer(0), detach(2)));
attempt("detached pair", () => equal(detach(2), detach(3)));
attempt("detached vs live", () => equal(detach(2), new ArrayBuffer(4)));
attempt("detached vs record", () => equal(detach(2), {}));
attempt("detached vs shared", () => equal(detach(2), new SharedArrayBuffer(2)));
attempt("detached nested", () => equal({ b: detach(2) }, { b: new ArrayBuffer(0) }));
attempt("detached in map", () => equal(new Map([["k", detach(2)]]), new Map([["k", new ArrayBuffer(0)]])));
attempt("detached skip prototypes", () => equal(detach(2), new ArrayBuffer(0), true));

const moved = new ArrayBuffer(3);
new Uint8Array(moved)[1] = 5;
const fixed = moved.transferToFixedLength(3);
attempt("transferred away", () => equal(moved, new ArrayBuffer(0)));
console.log("transferred contents", equal(fixed, (() => {
  const copy = new ArrayBuffer(3);
  new Uint8Array(copy)[1] = 5;
  return copy;
})()));

console.log("done");
