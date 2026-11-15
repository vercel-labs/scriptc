// @requires-libnode
// @env: NODE_NO_WARNINGS=1
// rejectionHandled across the two sides: a rejection already reported as
// unhandled raises rejectionHandled, on the listeners of both sides, when a
// handler is attached later, whichever side the promise and the late handler
// are on.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

const reported = [];
process.on("unhandledRejection", (reason, promise) => {
  reported.push(promise);
  log(`native unhandledRejection: ${reason.message}`);
});
process.on("rejectionHandled", (promise) => log(`native rejectionHandled: ${reported.includes(promise)}`));
lib.listen();

const steps = [
  () => {
    // A native promise, handled late by native code.
    const p = Promise.reject(new Error("native, native late"));
    setTimeout(() => p.catch((e) => log(`native late catch: ${e.message}`)), 10);
  },
  () => {
    // A native promise, handled late by island code.
    lib.catchLater(Promise.reject(new Error("native, island late")), 10);
  },
  () => {
    // An island promise, handled late by native code.
    const p = lib.rejected("island, native late");
    setTimeout(() => p.catch((e) => log(`native late catch: ${e.message}`)), 10);
  },
  () => {
    // An island promise, handled late by island code.
    lib.catchLater(lib.rejected("island, island late"), 10);
  },
  () => log(`reported ${reported.length}`),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 40);
  steps.shift()();
}, 5);
