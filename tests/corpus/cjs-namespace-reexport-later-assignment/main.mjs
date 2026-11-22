// A namespace import of a CommonJS wrapper that re-exports another module:
// Node's namespace keeps impl.cjs's values from the end of its evaluation,
// so `ns.current` reads null after `ns.set(5)` even though impl.cjs's own
// exports object now holds 5.
import * as ns from "./wrapper.cjs";

console.log(ns.current, ns.version);
ns.set(5);
console.log(ns.current, ns.version);
