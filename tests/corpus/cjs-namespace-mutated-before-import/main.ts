// The mutation runs before the namespace import below creates the ESM
// namespace object for the package.
import "./mutate.cjs"
import * as ns from "late-pkg"

console.log(ns.label())
