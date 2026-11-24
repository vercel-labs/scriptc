// A namespace import of a CommonJS wrapper that picks its export table at
// run time: the snapshot holds the chosen table's member, not the other
// table's uninitialized slot.
import * as ns from "switch-pkg"

console.log(ns.f())
