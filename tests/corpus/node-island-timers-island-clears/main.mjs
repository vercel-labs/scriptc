// @requires-libnode
// Island code clears timers the program created: the global functions and
// the node:timers ones, a timeout, an interval and an immediate, from the
// main body and from inside the timer's own callback, a list of them, and a
// handle that already fired.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

log(lib.sameFunctions());
log(`island numbers are ${lib.ownByNumber()}s`);

lib.clearT(setTimeout(() => log("NOT REACHED timeout"), 10));
lib.clearI(setTimeout(() => log("NOT REACHED timeout cleared with clearInterval"), 10));
lib.moduleClearT(setTimeout(() => log("NOT REACHED module timeout"), 10));
lib.clearAsString(setTimeout(() => log("NOT REACHED string"), 10));
lib.clearImm(setImmediate(() => log("NOT REACHED immediate")));
lib.moduleClearImm(setImmediate(() => log("NOT REACHED module immediate")));

// clearTimeout does not clear an immediate, and clearImmediate does not
// clear a timeout.
lib.clearT(setImmediate(() => log("immediate kept")));
lib.clearImm(setTimeout(() => log("timeout kept"), 10));

let ticks = 0;
const interval = setInterval(() => {
  log(`native interval tick ${++ticks}`);
  if (ticks === 3) lib.clearI(interval);
}, 100);

// An interval stopped by island code from a timer of the program.
let other = 0;
const stopped = setInterval(() => log(`second interval tick ${++other}`), 250);
setTimeout(() => lib.moduleClearI(stopped), 560);

const list = [];
for (let i = 0; i < 4; i++) list.push(setTimeout(() => log(`NOT REACHED list ${i}`), 30));
const survivor = setTimeout(() => log("survivor fires"), 650);
lib.clearAll(list);

// A handle that already fired clears nothing; one that is pending clears.
const fired = setTimeout(() => log("fired once"), 50);
const pending = setTimeout(() => log("NOT REACHED pending"), 850);
setTimeout(() => {
  lib.clearT(fired);
  lib.clearT(pending);
  log("cleared after firing");
}, 750);

const self = setTimeout(() => {
  lib.clearT(self);
  log("cleared itself");
}, 150);
setTimeout(() => log("end"), 900);
