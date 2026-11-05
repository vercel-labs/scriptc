"use strict";
// The island half of gc-cycles.mjs (node-island-gc.test.ts).
const { EventEmitter } = require("node:events");
const v8 = require("node:v8");
const vm = require("node:vm");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
v8.setFlagsFromString("--no-expose-gc");

class Ticker extends EventEmitter {
  constructor() {
    super();
    this.payload = new Array(64).fill(0);
  }
  tick(n) {
    return this.emit("tick", n);
  }
}

// An island object that will hold a native closure capturing it.
function box(n) {
  return { n, payload: new Array(64).fill(n), cb: null };
}
function call(o) {
  return o.cb();
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// An island WeakMap keyed by native objects.
const map = new WeakMap();
function remember(key, value) {
  map.set(key, value);
}
function recall(key) {
  return map.get(key);
}

// Island-side holders: strong (a Set) and weak (WeakRefs).
const held = new Set();
function hold(x) {
  held.add(x);
}
const weak = [];
function watch(x) {
  weak.push(new WeakRef(x));
}
// How many watched objects are still alive, and whether each is usable.
function alive() {
  let n = 0;
  for (const r of weak) if (r.deref() !== undefined) n++;
  return n;
}

function fullGc() {
  gc();
}

// The process's peak resident set in KiB (one process: both heaps).
function maxRss() {
  return process.resourceUsage().maxRSS;
}

module.exports = { Ticker, box, call, deferred, remember, recall, hold, held, watch, alive, fullGc, maxRss };
