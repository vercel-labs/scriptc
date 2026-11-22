// Node builds a CommonJS module's namespace object when the module finishes
// evaluating: a member an exported function reassigns afterwards keeps the
// end-of-evaluation value through the namespace, while the module's own
// exports object (and require) shows the new value.
import * as ns from "reassigning-pkg"
import { f, g } from "reassigning-pkg"
import pkg from "reassigning-pkg"

console.log(ns.f(), ns.g)
pkg.mutate()
console.log(ns.f(), ns.g, f(), g, pkg.f(), pkg.g)
