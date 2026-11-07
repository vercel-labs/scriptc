// @requires-libnode
// clearTimeout/clearInterval of a timer island code returned, and island
// clearTimeout of a timer native code created.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
clearTimeout(lib.start(10));
const iv = lib.startInterval(50);
setTimeout(() => clearInterval(iv), 125);
const mine = setTimeout(() => console.log("NOT REACHED native timer"), 10);
lib.clear(mine);
setTimeout(() => {
  console.log("end");
  iv.close();
}, 300);
