// atob, btoa and structuredClone as JavaScript values: function values
// whose calls run what the direct calls run, the same value through every
// spelling.
"use strict";
const buffer = require("buffer");

const fns = [atob, btoa, structuredClone];
for (const fn of fns) console.log(typeof fn, fn.name, fn.length);
console.log(buffer.atob === atob, buffer.btoa === globalThis.btoa, globalThis["structuredClone"] === structuredClone);

const pick = (name) => ({ atob, btoa, structuredClone })[name];
const encode = pick("btoa");
const decode = pick("atob");
console.log(encode("scriptc"), decode(encode("scriptc")), decode("aGk="));
const clone = pick("structuredClone");
const original = { list: [1, { deep: true }], text: "t" };
const copy = clone(original);
console.log(copy !== original, copy.list[1].deep, copy.list !== original.list, copy.text);

const report = (label, run) => {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
};
report("atob()", () => decode());
report("btoa()", () => encode());
report("structuredClone()", () => clone());
report("atob invalid", () => decode("a"));
report("btoa wide", () => encode("Ā"));
report("clone symbol", () => clone(Symbol("s")));
