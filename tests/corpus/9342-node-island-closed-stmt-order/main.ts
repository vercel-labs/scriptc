// @requires-libnode
// Island-closed statements and island-closed constants of two modules,
// interleaved. Nothing needs Node until the last line: the constants come
// from the build's snapshots, which the probe took after the statements
// before them. The first call then finds every registration made, in the
// program's order.
import { existsSync, readFileSync } from "node:fs";
import { alpha, beta, registry } from "plug-kit";
import { first } from "./early.ts";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

registry.register("one", beta);
const mid: number = registry.count();
registry.register("two", alpha);
registry.setLimit(mid);
const names: string = registry.list();

console.log("constants", first, mid, names);
console.log("libnode mapped:", libnodeMapped());
console.log("first use", registry.list(), registry.count(), registry.limit());
