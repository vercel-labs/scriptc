// @exit: 5
// @requires-libnode
// process.exit(5) called by island code several frames below native and
// island callers, inside try/finally on both sides: no finally runs, no
// later work runs, exit listeners of both sides run once.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit listener ${code}`));
lib.on("exit", "listener");
setTimeout(() => log("NOT REACHED timer"), 0);
lib.timer(0, "NOT REACHED");
Promise.resolve().then(() => log("NOT REACHED microtask"));

function nest(depth) {
  try {
    if (depth === 0) {
      log("exiting");
      lib.exit(5);
      log("NOT REACHED after exit");
      return;
    }
    lib.call(() => nest(depth - 1));
  } finally {
    log("NOT REACHED finally");
  }
}
nest(4);
log("NOT REACHED main end");
