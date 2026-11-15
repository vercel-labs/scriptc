// @exit: 1
// @requires-libnode
// An island promise held natively rejects unhandled: the ticks and
// microtasks already queued still run, then exit 1 through both sides'
// exit listeners.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log(`native exit listener ${code}`));
lib.onExit();
setTimeout(() => {
  const p = lib.rejected("nobody handles");
  lib.tick("after rejection");
  process.nextTick(() => console.log("native tick after rejection"));
  Promise.resolve().then(() => console.log("native microtask after rejection"));
  console.log(`held ${p instanceof Promise}`);
}, 5);
setTimeout(() => console.log("NOT REACHED"), 50);
