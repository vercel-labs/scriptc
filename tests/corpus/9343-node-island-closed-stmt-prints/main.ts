// @requires-libnode
// Island-closed statements whose island function prints: the build's probe
// meets the output, so those statements are not deferred and each evaluates
// where it stands, between the program's own statements, as in Node. The
// quiet one between them evaluates in place too: Node is running by then.
import { alpha, registry } from "plug-kit";

console.log("before");
registry.loud("one");
console.log("between");
registry.register("two", alpha);
registry.loud("three");
console.log("after", registry.list());
