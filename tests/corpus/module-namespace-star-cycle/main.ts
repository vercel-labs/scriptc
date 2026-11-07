import * as fromA from "./cycle-a.ts";
import * as fromB from "./cycle-b.ts";
import * as fromC from "./cycle-c.ts";

// A cycle of `export *` re-exports: every module in the cycle carries all
// three value exports, whichever module a key census starts from.
console.log(Object.keys(fromA).join(","));
console.log(Object.keys(fromB).join(","));
console.log(Object.keys(fromC).join(","));
console.log(fromB.gamma, fromC.alpha, fromA.beta);
const boxed: object = fromB;
console.log(Object.keys(boxed).join(","));
