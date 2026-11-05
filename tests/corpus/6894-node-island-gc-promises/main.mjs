// @requires-libnode
// Cross-heap cycles through promises (scope-B NI-8): an island object holds
// a native promise that settles with that island object; a native promise
// reaction to an island promise captures the island object holding it. The
// collector frees the settled cycles nothing holds, and never a pending
// one that will still settle.
import { requireModule } from "@scriptc/node";

const { awaitHeld, churn, deferred, hold, make, resolveHeld, settle } = requireModule("./lib.cjs");

const pending = [];
let total = 0;
for (let i = 0; i < 3000; i++) {
  // island object -> native promise -> settled with the island object
  const o = make(i);
  o.promise = new Promise((resolve) => {
    o.settle = (v) => resolve(v);
  });
  settle(o, o);
  total += (await o.promise).n;

  // island deferred -> native reaction -> captures the deferred
  const d = deferred();
  const reaction = d.promise.then((v) => v + d.payload.length);
  d.resolve(i);
  total += await reaction;

  // Pending cycles, settled only after the loop.
  if (i % 600 === 0) {
    const late = deferred();
    pending.push(late.promise.then((v) => v * 2 + late.payload.length));
    hold(late);
  }
  if (i % 700 === 0) hold(o);
  churn(4);
}
console.log("total", total);
console.log("resolved", resolveHeld());
console.log("pending", (await Promise.all(pending)).join(","));
console.log("held", await awaitHeld());
