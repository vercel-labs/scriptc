// @requires-libnode
// A natural end with thousands of live crossings each way (island objects
// held natively, native closures and objects held by the island, cycles
// through both heaps): exits 0 and, in a sanitized build, leaks nothing.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const nodes = [];
for (let i = 0; i < 2000; i++) {
  const n = lib.make(i);
  const native = { i, island: n };
  lib.link(n, native);
  lib.keep(() => native.i + nodes.length);
  nodes.push(n);
}
console.log(lib.runAll(), nodes.length, nodes[1999].peers[0].i);
setTimeout(() => console.log("end"), 5);
