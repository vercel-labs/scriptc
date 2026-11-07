// @exit: 4
// @requires-libnode
// An exit listener calls process.exit again with another code (from island
// code and from native code): the listeners do not run twice and the last
// code wins.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => {
  log(`native exit listener ${code}`);
  lib.exit(4);
});
lib.on("exit", "after");
process.on("exit", (code) => log(`NOT REACHED? native third ${code}`));
setTimeout(() => process.exit(2), 5);
