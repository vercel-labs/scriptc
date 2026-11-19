"use strict";
// Every require of a module answers the same object, and writes through
// any reference to it are seen by every other reference and by the
// module's own reads.
const lib = require("./lib");
const other = require("./other");
console.log(other.get() === lib, other.fresh() === lib, require("./lib") === lib);
console.log(lib.fromOther, lib.bump(), lib.count, lib.isSelf());
function poke(target) {
  target.count = 10;
}
poke(lib);
console.log(lib.count, lib.bump(), require("./lib").count, other.get().count);
lib.bump = function () {
  return "patched";
};
console.log(lib.bump(), other.fresh().bump(), Object.keys(lib).join(","));
