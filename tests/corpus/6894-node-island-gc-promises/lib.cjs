"use strict";
// Promises that tie island objects to native values.
function make(n) {
  return { n, payload: new Array(128).fill(n), settle: null, promise: null };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve, payload: new Array(64).fill(0) };
}
function settle(o, v) {
  o.settle(v);
}
function churn(kib) {
  let total = 0;
  for (let i = 0; i < kib; i++) total += new Array(128).fill(i).length;
  return total;
}
const held = [];
function hold(x) {
  held.push(x);
}
function resolveHeld() {
  let k = 0;
  for (const x of held) if (x.resolve) x.resolve(++k);
  return k;
}
async function awaitHeld() {
  const out = [];
  for (const x of held) {
    const v = await x.promise;
    out.push(typeof v === "number" ? v : v.n);
  }
  return out.join(",");
}
module.exports = { make, deferred, settle, churn, hold, resolveHeld, awaitHeld };
