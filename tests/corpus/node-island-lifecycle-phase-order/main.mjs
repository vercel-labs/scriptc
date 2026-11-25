// @requires-libnode
// From inside a timer callback and an fs callback (on either side) an
// immediate always runs before a zero timer, whichever side queued them.
import { stat } from "node:fs";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function queue(tag) {
  setTimeout(() => log(`${tag} timeout`), 0);
  setImmediate(() => log(`${tag} immediate`));
  process.nextTick(() => log(`${tag} tick`));
  queueMicrotask(() => log(`${tag} microtask`));
}

const steps = [
  (next) => setTimeout(() => { log("-- native timer"); queue("n"); lib.queue("i"); setTimeout(next, 20); }, 1),
  (next) => lib.inTimer(() => { log("-- island timer"); lib.queue("i"); queue("n"); setTimeout(next, 20); }),
  (next) => stat(import.meta.filename, () => { log("-- native fs callback"); queue("n"); lib.queue("i"); setTimeout(next, 20); }),
  (next) => lib.inFs(() => { log("-- island fs callback"); lib.queue("i"); queue("n"); setTimeout(next, 20); }),
];
(function run(i) {
  if (i < steps.length) steps[i](() => run(i + 1));
  else log("done");
})(0);
