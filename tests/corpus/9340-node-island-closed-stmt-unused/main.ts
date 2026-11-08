// @requires-libnode
// Module-level statements whose whole effect is on a Node island's state:
// each is one call into the island package with literal arguments and
// island values. The island evaluates such a statement itself (a generated
// island module per statement), deferred like the package's own module: the
// program never asks the registry anything, so Node never starts and
// libnode is never mapped.
import { existsSync, readFileSync } from "node:fs";
import { alpha, beta, registry } from "plug-kit";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

registry.register("alpha", alpha);
registry.register("beta", beta);
registry.setLimit(8);

console.log("start");
console.log(typeof registry, typeof alpha, typeof beta);
console.log("libnode mapped:", libnodeMapped());
console.log("end");
