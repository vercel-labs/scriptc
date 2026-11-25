// @exit: 7
// @requires-libnode
// An uncaughtException listener that throws ends the process with code 7,
// whichever side the listener and the first error are on: here a native
// listener throws while handling an error from island code, after an island
// listener registered before it has run. The listener after it does not run.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

lib.install("first");
process.on("uncaughtException", (e) => {
  log(`native listener: ${e.message}`);
  throw new Error("the listener failed");
});
lib.install("NOT REACHED");
setTimeout(() => log("NOT REACHED"), 60);
lib.throwSoon("island failure");
