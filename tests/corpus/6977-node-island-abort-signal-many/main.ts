// @requires-libnode
// A long session: one AbortController per request, its signal handed to a
// Node island in a record, most never aborted. Each pair of signals is
// collected with its request, a signal either side still holds stays
// paired, and nothing here keeps the program alive.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface RequestOptions {
  signal: AbortSignal;
  attempt: number;
}

const kept: AbortController[] = [];
for (let i = 0; i < 100_000; i++) {
  const controller = new AbortController();
  const options: RequestOptions = { signal: controller.signal, attempt: i };
  const done: () => void = lib.request(options);
  // Every thousandth request is cancelled while its listener is in place.
  if (i % 1000 === 500) controller.abort(i);
  done();
  // A few controllers outlive their request on each side.
  if (i % 10_000 === 0) {
    kept.push(controller);
    lib.forget(controller.signal);
  }
  if (i % 25_000 === 0) lib.hold(controller.signal);
}
console.log(lib.counts());

// The controllers the program kept still reach the island's listeners,
// however many collections ran in between.
for (const controller of kept) controller.abort("late");
console.log(lib.counts(), "held aborted", lib.heldAborted());

// Signals that never abort, with a timer of their own, do not hold the
// program open.
lib.hold(AbortSignal.timeout(3_600_000));
lib.forget(new AbortController().signal);
console.log("done");
