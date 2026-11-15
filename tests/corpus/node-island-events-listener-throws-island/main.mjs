// @exit: 7
// @requires-libnode
// An island uncaughtException listener that throws while handling an error
// native code let escape ends the process with code 7; the native listener
// registered after it does not run.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("uncaughtException", (e) => log(`native first: ${e.message}`));
lib.install();
process.on("uncaughtException", () => log("NOT REACHED"));
setTimeout(() => log("NOT REACHED"), 60);
setTimeout(() => {
  throw new Error("native failure");
}, 5);
