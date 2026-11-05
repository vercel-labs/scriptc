// @requires-libnode
// Cross-heap cycles through native closures (scope-B NI-8): an island
// object holds a native closure that captures that island object, and a
// pair of island objects hold closures capturing each other. The collector
// frees the cycles nothing holds; those held by native code (a native
// closure, a native array) or by island code keep working.
import { requireModule } from "@scriptc/node";

const { churn, hold, make, ping, pingHeld } = requireModule("./lib.cjs");

const nativeHeld = [];
const viaClosure = [];
let total = 0;
for (let i = 0; i < 4000; i++) {
  const o = make(i);
  o.onPing = (k) => o.n + k + o.payload.length;
  total += ping(o, 1);

  // Two island objects whose closures capture each other.
  const a = make(i);
  const b = make(-i);
  a.onPing = (k) => b.n * k;
  b.onPing = (k) => a.n * k;
  total += ping(a, 2) + ping(b, 3);

  if (i % 800 === 0) nativeHeld.push(o);
  if (i % 900 === 0) viaClosure.push(() => ping(a, 1) + ping(b, 1));
  if (i % 1000 === 0) hold(b);
  churn(4);
}
console.log("total", total);
console.log("native held", nativeHeld.map((o) => ping(o, 0)).join(","));
console.log("via closure", viaClosure.map((f) => f()).join(","));
console.log("island held", pingHeld(5));
