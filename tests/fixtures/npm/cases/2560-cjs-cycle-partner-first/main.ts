// The same esbuild CommonJS cycle entered through a partner: merge.js
// loads first, requires index.js, which requires merge.js back while
// merge is still initializing (its getter table is already installed) and
// re-exports mergeAll from it: the re-export reads merge's hoisted
// function while merge is still initializing.
import { mergeAll } from "gtcycle/dist/merge.js";
import { run, mergeAll as reexported } from "gtcycle";

console.log(mergeAll([" x "], ["@keep"]).join(","));
console.log(reexported === mergeAll);
console.log(run(["y"], ["@z"]));
