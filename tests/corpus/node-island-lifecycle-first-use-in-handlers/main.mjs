// @requires-libnode
// The first use of island code happens inside an uncaughtException
// listener, with native timers, an interval and promise jobs pending; later
// uses come from an unhandledRejection listener and a signal listener.
import { callSync } from "@scriptc/node";

const log = (s) => console.log(s);
process.on("uncaughtException", (e) => {
  log(`uncaught ${e.message}`);
  callSync("./lib.cjs", "note", "uncaught");
  callSync("./lib.cjs", "later", "after uncaught");
});
process.on("unhandledRejection", (r) => {
  log(`unhandled ${r.message}`);
  callSync("./lib.cjs", "note", "unhandled");
});
process.on("SIGUSR2", () => {
  callSync("./lib.cjs", "note", "signal");
  clearInterval(iv);
});
let ticks = 0;
const iv = setInterval(() => {
  if (++ticks === 3) process.kill(process.pid, "SIGUSR2");
}, 10);
Promise.resolve().then(() => log("microtask before"));
setTimeout(() => {
  throw new Error("first");
}, 1);
setTimeout(() => {
  Promise.reject(new Error("second"));
}, 15);
log("main end");
