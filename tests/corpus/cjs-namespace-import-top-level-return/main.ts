// A namespace import of a CommonJS module whose evaluation ends with a
// top-level return: the members its functions assigned before the return are
// the ones Node's namespace holds, and a call through the namespace reaches
// the function the module finished with rather than an unassigned slot.
import * as ns from "topreturn-pkg"

console.log(ns.f(), ns.n)
const held = ns.f
console.log(held())
