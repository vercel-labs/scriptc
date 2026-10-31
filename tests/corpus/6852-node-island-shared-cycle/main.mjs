// @requires-libnode
// An import cycle through a Node island (scope-B NI-6): the compiled package
// `core` imports the island package `ext`, which imports `core` back. As in
// Node, `ext` evaluates first and sees core's functions (hoisted) but its
// let and const bindings in their temporal dead zone; once core's body ran,
// the same bindings read core's live values.
import { check, x } from "core";

console.log("main:", check());
console.log("main x:", x);
