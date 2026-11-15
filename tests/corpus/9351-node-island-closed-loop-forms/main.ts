// @requires-libnode
// The forms an island-closed loop takes: over an array of names, over an
// array of pairs taken apart by the loop's binding, over the keys and the
// values of a table, with a body of one statement or several. Each table
// is named only by its loop, so the island holds it.
import { alpha, beta, type Plugin, registry } from "plug-kit";

const names = ["one", "two"];
for (const name of names) registry.register(name, alpha);

const pairs: [string, Plugin][] = [
  ["three", alpha],
  ["four", beta],
];
for (const [name, plugin] of pairs) registry.register(name, plugin);

const table = { five: beta, six: alpha };
for (const key of Object.keys(table)) registry.register(key, alpha);
for (const plugin of Object.values(table)) {
  registry.register("again", plugin);
  registry.setLimit(6);
}

console.log(registry.list());
console.log(registry.count(), registry.limit());
