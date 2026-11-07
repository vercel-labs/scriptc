// A member export is read through its binding only when that binding still
// holds the exported value: a member that holds a reassigned binding, or one
// that both a module and its re-exporter write, is refused.
import { counter, version } from "metrics";
console.log(counter);
console.log(version);

// `metrics` is marked native in package.json, so this program pins the native
// refusal. Left to the island decision, the package runs in a Node island and
// the program prints what Node prints
// (tests/corpus/8740-node-island-unbound-export).
