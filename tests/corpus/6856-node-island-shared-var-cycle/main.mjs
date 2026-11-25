// @requires-libnode
// An import cycle through a Node island: the compiled package `core` imports
// the island package `ext`, which imports `core` back. As in Node, `ext`
// evaluates first and reads core's `var` exports as undefined (a var is
// hoisted, its initializer has not run), also the one whose value is a
// class; once core's body ran, the same bindings read core's live values.
import { Shape, check, count } from "core";

console.log("main:", check());
console.log("main Shape:", new Shape(count).area());
