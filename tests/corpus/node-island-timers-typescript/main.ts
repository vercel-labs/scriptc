// @requires-libnode
// The same crossings from TypeScript: an island's values are untyped, and
// the program's own timers are typed.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s: string): void => console.log(s);

clearTimeout(lib.timeout(10, "NOT REACHED timeout"));
clearImmediate(lib.immediate("NOT REACHED immediate"));
let ticks = 0;
const islandInterval = lib.interval(100, () => {
  log(`island interval tick ${++ticks}`);
  if (ticks === 2) clearInterval(islandInterval);
});

const mine: ReturnType<typeof setTimeout> = setTimeout(() => log("NOT REACHED native timeout"), 10);
lib.clearT(mine);
const soon: ReturnType<typeof setImmediate> = setImmediate(() => log("NOT REACHED native immediate"));
lib.clearImm(soon);
let own = 0;
const nativeInterval: ReturnType<typeof setInterval> = setInterval(() => {
  log(`native interval tick ${++own}`);
  if (own === 2) lib.clearI(nativeInterval);
}, 140);
let maybe: ReturnType<typeof setTimeout> | undefined = setTimeout(() => log("NOT REACHED optional"), 10);
lib.clearT(maybe);
maybe = undefined;
clearTimeout(maybe);
setTimeout(() => log("end"), 400);
