// AbortSignal twins are collected with their requests (node-island-gc.test.ts):
// each iteration makes a controller, hands its signal to the island in a
// record, and drops both; then the island makes a signal per iteration and
// the program reads it and drops it. Ten controllers stay with the program and four
// signals with the island whatever the count, so what a run holds at its
// end does not grow with it. Usage: gc-signals <n> [collections]
// (collections: that many full V8 collections after the last request, each
// followed by a turn of the loop, before the kept controllers abort).
import { requireModule } from "@scriptc/node";

const lib = requireModule("./gc-signals.cjs");
const n = Number(process.argv[2] ?? "1000");
const kept = [];
for (let i = 0; i < n; i++) {
  const controller = new AbortController();
  const done = lib.request({ signal: controller.signal, attempt: i });
  if (i % 1000 === 500) controller.abort(i);
  done();
  if (i < 10) {
    kept.push(controller);
    lib.forget(controller.signal);
  } else if (i < 14) {
    lib.hold(controller.signal);
  } else if (i < 16) {
    lib.hold(AbortSignal.any([controller.signal, kept[0].signal]));
  }
}
// The other way: a signal the island makes per request, which a native
// signal stands for while the program uses it.
// The island's signal is collected like any object a WeakRef names: not
// before the current job ends, so the requests come in separate turns, as
// a program's do.
let islandAborted = 0;
for (let i = 0; i < n; i++) {
  const signal = lib.own();
  if (signal.aborted) islandAborted++;
  if (i % 500 === 499) await new Promise((resolve) => setImmediate(() => resolve(undefined)));
}
// What a run holds once V8 has collected is what it keeps, whenever V8 last
// collected by itself.
const collections = Number(process.argv[3] ?? "0");
for (let round = 0; round < collections; round++) {
  lib.fullGc();
  await new Promise((resolve) => setImmediate(() => resolve(undefined)));
}
// The program's controllers still reach the island's listeners and the
// signals that follow them.
for (const controller of kept) controller.abort("late");
console.log(lib.counts(), islandAborted);
