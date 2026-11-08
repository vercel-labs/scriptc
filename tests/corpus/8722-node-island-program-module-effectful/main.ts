// @requires-libnode
// A module of the program that runs in a Node island and whose top level
// prints. The build never evaluates such a module (its top level is not
// provably free of effects), so it loads where it is imported and its
// output comes before the entry's own, as in Node. The patching module
// beside it only declares, and waits until the entry calls it.
import { installPatch } from "./patch.ts";
import { readThroughRequire } from "./read.ts";

console.log("main body");
installPatch();
console.log("reader:", readThroughRequire());
