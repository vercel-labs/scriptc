"use strict";
// Island objects that hold native callbacks.
function make(n) {
  return { n, payload: new Array(128).fill(n), onPing: null, onBoth: null };
}
function ping(o, k) {
  return o.onPing(k);
}
function churn(kib) {
  let total = 0;
  for (let i = 0; i < kib; i++) total += new Array(128).fill(i).length;
  return total;
}
// Island-side roots.
const held = [];
function hold(o) {
  held.push(o);
}
function pingHeld(k) {
  return held.map((o) => o.onPing(k)).join(",");
}
module.exports = { make, ping, churn, hold, pingHeld };
