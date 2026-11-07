// AbortSignal twins are collected with their requests (node-island-gc.test.ts):
// each iteration makes a controller, hands its signal to the island in a
// record, and drops both. Ten controllers stay with the program and four
// signals with the island whatever the count, so what a run holds at its
// end does not grow with it. Usage: gc-signals <n>
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
// The program's controllers still reach the island's listeners and the
// signals that follow them.
for (const controller of kept) controller.abort("late");
console.log(lib.counts());
