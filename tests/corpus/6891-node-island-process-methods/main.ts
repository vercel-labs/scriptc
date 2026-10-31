// @requires-libnode
// The island host wraps process's emitter methods; island code sees them as
// Node's own: `on` is `addListener`, each keeps its name, length and
// prototype, none is an own property of process, and Object.keys and
// for...in over process list what they list in Node.
import { callSync } from "@scriptc/node";

console.log(callSync<string>("./probe.cjs", "probe"));
