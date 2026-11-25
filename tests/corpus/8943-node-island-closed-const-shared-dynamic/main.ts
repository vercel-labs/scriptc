// @requires-libnode
// An island-closed constant in a module that a dynamically imported module
// also imports. Statically nothing says the dynamic import does not run
// first, so the build cannot promise the order; the run can: this one loads
// nothing before the constant that the build's probe did not, so its
// snapshot holds, the program never uses the value, and Node never starts.
import { existsSync, readFileSync } from "node:fs";
import { shared } from "./shapes.ts";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("start", typeof shared);
if (process.argv.length > 99) {
  const extra = await import("./extra.ts");
  console.log(extra.describeShared());
}
console.log("libnode mapped:", libnodeMapped());
