"use strict";
const kept = [];

function describe(o) {
  return Object.keys(o).map((k) => `${k}=${o[k]}`).join(" ");
}

function bump(o, by) {
  o.count += by;
  o.label = `${o.label}+`;
  return o.count;
}

function keep(o) { kept.push(o); return kept.length; }
function keptAt(i) { return kept[i]; }
function same(a, b) { return a === b; }
function has(o, k) { return k in o; }
function readThrough(o) { return `${o.greeting}, island (${Object.keys(o).join(",")})`; }
function store(o) { return { inner: o }; }

// Reads a property from a Node timer: outside any call from the program.
function readLater(o) {
  return new Promise((resolve) => setTimeout(() => resolve(`${o.label}/${o.count}`), 0));
}

module.exports = { describe, bump, keep, keptAt, same, has, readThrough, store, readLater };
