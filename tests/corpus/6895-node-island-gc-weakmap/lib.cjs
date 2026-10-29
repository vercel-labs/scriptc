"use strict";
// An island WeakMap keyed by native objects, and WeakRefs to them.
const notes = new WeakMap();
function note(key, value) {
  notes.set(key, value);
}
function noteOf(key) {
  return notes.get(key);
}
function has(key) {
  return notes.has(key);
}
function make(n) {
  return { n, payload: new Array(128).fill(n), read: null };
}
function read(v) {
  return v.read();
}
const refs = [];
function watch(x) {
  refs.push(new WeakRef(x));
}
// Watched objects native code still holds must be alive and the same.
function watchedAlive(objs) {
  return refs.filter((r, i) => r.deref() === objs[i]).length;
}
function churn(kib) {
  let total = 0;
  for (let i = 0; i < kib; i++) total += new Array(128).fill(i).length;
  return total;
}
module.exports = { note, noteOf, has, make, read, watch, watchedAlive, churn };
