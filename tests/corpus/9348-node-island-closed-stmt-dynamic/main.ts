// @requires-libnode
// Island-closed statements in a module the program imports dynamically,
// after its own. The build cannot know when that module initializes, so
// each of its generated modules is guarded by the loads registered before
// it: in a run that reaches them in another order than the build's probe
// did, they evaluate where they stand.
import { alpha, registry } from "plug-kit";

registry.register("main", alpha);
const late = await import("./late.ts");
console.log("late", late.size);
registry.register("last", alpha);
console.log(registry.list(), registry.count());
