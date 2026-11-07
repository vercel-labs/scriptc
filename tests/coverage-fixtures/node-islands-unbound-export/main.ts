// ni-metrics compiles natively, and nothing in its own modules refuses or
// needs Node.js. The program reads two member exports whose bindings no
// longer hold the exported value, so the compiled package has no binding to
// read them from: a build runs the package in a Node island for it. The
// report names the same island, with the export and the read as its reason,
// and the island gates fail on it.
import { counter, version } from "ni-metrics";

console.log(counter, version);
