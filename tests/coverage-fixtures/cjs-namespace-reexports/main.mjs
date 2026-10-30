// A namespace import of a CommonJS wrapper that re-exports another module:
// Node's namespace keeps impl.cjs's values from the end of its evaluation,
// so `ns.current` reads null after `ns.set(5)`.
import * as ns from "./wrapper.cjs";

ns.set(5);
console.log(ns.current, ns.version);
