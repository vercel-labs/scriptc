// @requires-libnode
// ES modules as islands: require(esm) of a synchronous module, and a module
// with top-level await, which require() refuses by code.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.mjs");
console.log(lib.answer, lib.default(), await lib.later(2, "later"));
try {
  requireModule("./tla.mjs");
  console.log("NOT REACHED");
} catch (e) {
  console.log(`caught ${e.code}`);
}
console.log("end");
