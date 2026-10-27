// Two bundled CommonJS chunks export the bundle's top-level `tally` and
// count calls on a property of it. Node prints "1 2 true": both chunks
// share one function. A per-chunk copy would split its identity and its
// properties, so the package stays refused.
import { counts, same } from "gtchunkshared";

console.log(counts(), same());
