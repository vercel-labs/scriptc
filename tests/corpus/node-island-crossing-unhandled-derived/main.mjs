// @requires-libnode
// @exit: 1
// A native reaction without a rejection handler on an island promise: the
// promise it returns is the unhandled one.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log("exit", code));
lib.failing(20, "derived").then((v) => console.log("not reached", v));
setTimeout(() => console.log("at 5 ms"), 5);
setTimeout(() => console.log("never printed"), 200);
