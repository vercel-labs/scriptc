// @requires-libnode
// Timers of both sides queued from one timer callback: equal deadlines run
// in creation order across the sides; an island Timeout is driven through
// its handle (hasRef, unref, ref, refresh); each side stops its own interval.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

setTimeout(() => {
  setTimeout(() => log("native a"), 20);
  lib.timeout(20, "b");
  setTimeout(() => log("native c"), 20);
  lib.timeout(20, "d");
  lib.timeoutCb(20, () => log("native e via island timer"));
  lib.timeout(40, "g at 40");
  setTimeout(() => log("native f at 30"), 30);
}, 1);

let n = 0;
const islandInterval = lib.interval(100, () => {
  log(`island interval tick ${++n}`);
  if (n === 2) islandInterval.close();
});
lib.args((a, b, c) => log(`args ${a} ${b} ${c.k}`));

const t = lib.timeout(400, "refreshed timer");
log(`hasRef ${t.hasRef()}`);
t.unref();
log(`hasRef after unref ${t.hasRef()}`);
t.ref();
setTimeout(() => {
  t.refresh();
  log("refreshed");
}, 250);
setTimeout(() => log("native at 500"), 500);
log("main end");
