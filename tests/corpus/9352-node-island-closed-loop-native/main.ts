// @requires-libnode
// Loops that stay as they were. The first table is also read by the
// program's own code, so it is a native constant and the loop over it is
// lowered call by call. The second loop's body calls a function of the
// program. The third declares its binding with `let`: the island takes
// only loops whose bindings are `const`.
import { alpha, registry } from "plug-kit";

const names = ["one", "two"];
for (const name of names) registry.register(name, alpha);
console.log("names", names.length);

const more = ["three"];
for (const name of more) {
  registry.register(name, alpha);
  console.log("registered", name);
}

const last = ["four"];
for (let name of last) registry.register(name, alpha);

console.log(registry.list(), registry.count());
