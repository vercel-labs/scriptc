// @requires-libnode
// @exit: 1
// An island promise that rejects with no reaction on either side ends the
// program as an unhandled rejection, when it rejects.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log("exit", code));
const held = lib.failing(20, "nobody handles this");
setTimeout(() => console.log("at 5 ms", typeof held), 5);
setTimeout(() => console.log("never printed"), 200);
