// @no-node-shims
// Node 24's navigator global: its members are getters on
// Navigator.prototype answering the process's values, and the object
// itself owns no properties. It is one of the global object's enumerable
// properties.
"use strict";
const os = require("os");
const util = require("util");

console.log(typeof navigator, navigator.userAgent);
console.log(navigator.hardwareConcurrency === os.availableParallelism());
console.log(typeof navigator.language, navigator.language.length > 0);
console.log(navigator.languages.length, navigator.languages[0] === navigator.language);
console.log(navigator.languages === navigator.languages, Object.isFrozen(navigator.languages));
const platforms = {
  linux: { x64: "Linux x86_64", arm64: "Linux arm64" },
  darwin: { x64: "MacIntel", arm64: "MacIntel" },
};
console.log(navigator.platform === platforms[process.platform]?.[process.arch]);

const value = navigator;
console.log(value === navigator, value === globalThis.navigator, value === globalThis["navigator"]);
console.log(value.userAgent, value.platform === navigator.platform, value.missing);
console.log(Object.keys(value), JSON.stringify(value), util.inspect(value));
console.log(String(value), Object.prototype.toString.call(value));

const keys = [];
for (const key in globalThis) keys.push(key);
console.log(keys.join(","));
const known = new Set([
  global,
  clearImmediate,
  setImmediate,
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
  queueMicrotask,
  structuredClone,
  atob,
  btoa,
  performance,
  fetch,
  crypto,
  navigator,
]);
console.log("leaked", keys.filter((key) => !known.has(globalThis[key])).length);
