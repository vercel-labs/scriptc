// @requires-libnode
// Island-closed statements and constants on both sides of the program's
// first call into the island. The ones before it wait, and the call finds
// them evaluated; the ones after it evaluate where they stand, since Node
// is running, and see the calls before them.
import { alpha, registry } from "plug-kit";

registry.setLimit(2);
const before: number = registry.limit();
console.log("before", before, registry.count());
registry.setLimit(4);
registry.register("alpha", alpha);
const after: number = registry.limit();
console.log("after", after, registry.count());
