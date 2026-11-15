// @requires-libnode
// A TypeScript module the project marks to run in a Node island
// (`scriptc.nodeIslands.modules`): Node runs it with its types stripped, so
// the code it builds from strings works, and the program reaches its
// exports across the boundary.
import { compileAdder, describe, tally } from "./legacy.ts";

const add = compileAdder(3);
console.log(add(4), add(-3));
console.log(describe("island"));
console.log(tally([1, 2, 3, 4]));
