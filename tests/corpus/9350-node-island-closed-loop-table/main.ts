// @requires-libnode
// A table of island values and a module-level loop that hands each entry
// to the island: the loop is one island-closed statement, and the table,
// which nothing else in the program names, is a constant the island
// evaluates too. Both wait like the package's own module: Node starts at
// the first call that asks the registry something, which finds every entry
// registered in the table's order.
import { existsSync, readFileSync } from "node:fs";
import { alpha, beta, registry } from "plug-kit";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

const plugins = { alpha, beta, gamma: registry.make("gamma") };

for (const [name, plugin] of Object.entries(plugins)) {
  registry.register(name, plugin);
}

console.log("start");
console.log("libnode mapped:", libnodeMapped());
console.log("first use", registry.list(), registry.count());
