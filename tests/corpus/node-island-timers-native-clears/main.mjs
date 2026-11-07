// @requires-libnode
// clearTimeout, clearInterval and clearImmediate of timers island code
// created, called by the program: before they fire, from inside a callback,
// after they fired, with the other clear function, and through values that
// are not timers.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

const cleared = lib.timeout(15, "NOT REACHED cleared");
clearTimeout(cleared);
log(`destroyed ${lib.destroyed(cleared)}`);
clearTimeout(cleared);

const byInterval = lib.timeout(15, "NOT REACHED cleared with clearInterval");
clearInterval(byInterval);

const fromModule = lib.fromModule(15, "NOT REACHED module");
clearTimeout(fromModule);

const immediate = lib.immediate("NOT REACHED cleared");
clearImmediate(immediate);

// clearTimeout does not clear an Immediate, as in Node.
const kept = lib.immediate("kept");
clearTimeout(kept);

let ticks = 0;
const interval = lib.interval(100, () => {
  log(`island interval tick ${++ticks}`);
  if (ticks === 3) clearInterval(interval);
});

const late = lib.timeout(150, "fires");
setTimeout(() => {
  clearTimeout(late);
  log(`late destroyed ${lib.destroyed(late)}`);
}, 450);

// An interval stopped from a timer of the program, with clearTimeout.
let stops = 0;
const stoppedByTimer = lib.interval(250, () => log(`second interval tick ${++stops}`));
setTimeout(() => clearTimeout(stoppedByTimer), 560);

// Values that are not timers clear nothing.
for (const value of [lib, {}, "text", true, [], () => {}]) {
  clearTimeout(value);
  clearInterval(value);
  clearImmediate(value);
}
setTimeout(() => log("end"), 700);
