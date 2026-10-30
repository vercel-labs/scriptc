// @no-node-shims
// Builtin globals read through the global object by computed names, and
// builtin module members that are global objects: each answers what the
// global's own spelling reads, so identity holds across the spellings.
// for-in over the global object visits Node's enumerable globals first and
// the program's own global properties after them.
"use strict";
const { atob: bufferAtob, btoa: bufferBtoa } = require("buffer");
const timers = require("timers");
const { performance: perf } = require("perf_hooks");
const util = require("util");
const url = require("url");
const { MessageChannel } = require("worker_threads");
const web = require("stream/web");

const names = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "global",
  "globalThis",
  "fetch",
  "Map",
  "Object",
  "Promise",
  "Buffer",
  "crypto",
];
for (const name of names) {
  const value = globalThis[name];
  console.log(name, typeof value, value === globalThis[name]);
}
console.log(
  globalThis["setTimeout"] === setTimeout,
  globalThis["Map"] === Map,
  globalThis["crypto"] === crypto,
  globalThis["Buffer"] === Buffer,
);
console.log(timers.setTimeout === setTimeout, timers.clearInterval === globalThis["clearInterval"]);
console.log(
  bufferAtob === atob,
  bufferBtoa === globalThis["btoa"],
  perf === performance,
  util.TextEncoder === TextEncoder,
  url.URL === URL,
  MessageChannel === globalThis["MessageChannel"],
  web.ReadableStream === ReadableStream,
);
console.log(globalThis["noSuchGlobal"], typeof globalThis["Temporal"]);
// A snapshot of the global object in a function reads the same values.
function readThroughSnapshot(name) {
  const g = globalThis;
  return g[name];
}
console.log(
  readThroughSnapshot("setTimeout") === setTimeout,
  readThroughSnapshot("Map") === Map,
  typeof readThroughSnapshot("structuredClone"),
  readThroughSnapshot("noSuchGlobal"),
);
const pick = (name) => globalThis[name];
console.log(pick("Math") === Math, pick("JSON") === JSON, pick("Reflect") === Reflect, pick("Math").max(1, 3));

const before = [];
for (const key in globalThis) before.push(key);
globalThis.ownA = 1;
globalThis["own" + "B"] = { b: 2 };
const after = [];
for (const key in globalThis) after.push(key);
console.log(after.length - before.length, after.slice(-2).join(","));
console.log(before.slice(0, 9).join(","));
console.log(globalThis.ownA, globalThis.ownB.b, globalThis["ownB"] === globalThis.ownB);

// The harness's leak check: every enumerated global is a known value.
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
  bufferAtob,
  bufferBtoa,
  performance,
  fetch,
  crypto,
  globalThis.ownA,
  globalThis.ownB,
]);
const leaked = after.filter((key) => key !== "navigator" && !known.has(globalThis[key]));
console.log("leaked", leaked.length);
