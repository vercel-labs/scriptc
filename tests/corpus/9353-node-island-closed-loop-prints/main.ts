// @requires-libnode
// An island-closed loop whose island function prints: the build's probe
// meets the output, so the loop is not deferred and runs where it stands,
// between the program's own statements, as in Node. Its table is still the
// island's: it evaluates when the loop starts Node, ahead of it.
import { registry } from "plug-kit";

const names = ["one", "two"];
console.log("before");
for (const name of names) registry.loud(name);
console.log("after", registry.list(), registry.count());
