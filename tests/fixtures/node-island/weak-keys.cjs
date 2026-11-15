"use strict";
// The island half of weak-keys.mjs (node-island-weak-keys.test.ts): plain
// objects the island makes, keeps or forgets, and hands back.
const v8 = require("node:v8");
const vm = require("node:vm");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
v8.setFlagsFromString("--no-expose-gc");

function make(i) {
  return { i, payload: new Array(32).fill(i) };
}
function same(value) {
  return value;
}
// An island object that reaches the object it was made for.
function owner(value) {
  return { owns: value };
}

// Keys only the island keeps: the program drops its handle and gets the
// object back later.
const kept = [];
function keep(value) {
  kept.push(value);
  return 1;
}
function keptKeys() {
  return kept;
}

// Weak references inside the island, to see which objects are alive.
const weak = [];
function watch(value) {
  weak.push(new WeakRef(value));
}
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

module.exports = { make, same, owner, keep, keptKeys, watch, alive, fullGc, maxRss };
