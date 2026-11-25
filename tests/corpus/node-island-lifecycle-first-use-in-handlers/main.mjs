// @requires-libnode
// The first use of island code happens inside an uncaughtException
// listener, with native timers, an interval and promise jobs pending; later
// uses come from a native timer, an unhandledRejection listener and a signal
// listener.
//
// Each step waits for the one before it, not for a number of milliseconds:
// the listener that starts Node can take longer than any gap between two
// timers, and Node itself runs a timer that came due during a slow listener
// before one the listener created.
import { callSync } from "@scriptc/node";

const log = (s) => console.log(s);
let noted = false;
let unhandled = false;
process.on("uncaughtException", (e) => {
  log(`uncaught ${e.message}`);
  callSync("./lib.cjs", "note", "uncaught");
  callSync("./lib.cjs", "later", "after uncaught");
  noted = true;
});
process.on("unhandledRejection", (r) => {
  log(`unhandled ${r.message}`);
  callSync("./lib.cjs", "note", "unhandled");
  unhandled = true;
});
process.on("SIGUSR2", () => {
  callSync("./lib.cjs", "note", "signal");
  clearInterval(iv);
});
let ticks = 0;
const iv = setInterval(() => {
  // After three ticks, and once the rejection below was reported.
  if (++ticks >= 3 && unhandled) process.kill(process.pid, "SIGUSR2");
}, 10);
Promise.resolve().then(() => log("microtask before"));
setTimeout(() => {
  throw new Error("first");
}, 1);
// Pending when Node starts, like the interval. It rejects once the island's
// own timer has run.
const second = () => {
  if (!noted || !callSync("./lib.cjs", "fired")) {
    setTimeout(second, 1);
    return;
  }
  Promise.reject(new Error("second"));
};
setTimeout(second, 15);
log("main end");
