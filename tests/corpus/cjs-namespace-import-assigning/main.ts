// A namespace import of a CommonJS module that assigns its exports inside a
// function it calls while it evaluates: a member read lowers like the named
// import of the same name, and the call reaches the function the module
// finished with.
import * as ns from "assigning-pkg"

console.log(ns.f(), ns.g)
