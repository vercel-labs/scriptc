// Island objects the program drops are released (scope-B NI-4, acyclic
// garbage): after many iterations that each take handles to fresh Node
// objects, buffers, errors and promises, the import table holds only what
// the program still references. node-island-handles.test.ts reads the
// count SCRIPTC_NODE_ISLANDS_TRACE=handles prints at exit.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./handles-leak.cjs");
const n = Number(process.argv[2] ?? "20000");
let sum = 0;
for (let i = 0; i < n; i++) {
  const o = lib.make(i);
  sum += o.i + o.payload.length;
  const b = lib.buffer(i);
  sum += b[0];
  try {
    lib.fail(i);
  } catch (e) {
    sum += e.message.length;
  }
}
let awaited = 0;
for (let i = 0; i < 1000; i++) awaited += await lib.later(i);
const kept = lib.make(-1);
console.log("sum", sum, awaited, kept.tag);
