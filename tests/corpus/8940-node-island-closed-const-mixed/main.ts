// @requires-libnode
// Constants beside island-closed ones. One names a native binding, so it
// is not closed and keeps its call-by-call lowering. One is an island array
// the program holds as a handle and changes before a later closed
// initializer names it: that initializer sees the change, because the
// constant it names is the island's own array, not a copy.
import { describe, Kit } from "shape-kit";

const limit = 3;
const bounded = Kit.number({ min: limit });
const tags: string[] = Kit.labels();
tags.push("extra");
const tagged = Kit.tagged(tags);
const closed = Kit.list(Kit.text({ label: "closed" }));

console.log(describe(bounded), describe(tagged), describe(closed));
console.log(bounded.serial, tagged.serial, closed.serial);
