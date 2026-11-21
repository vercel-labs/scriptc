// The mutation runs before the namespace import below creates the ESM
// namespace object for the module.
import "./mutate.cjs"
import * as ns from "./pkg.cjs"

console.log(ns.label())
