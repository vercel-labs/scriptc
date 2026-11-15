// @requires-libnode
// A module of the program that runs in a Node island, imported by two of
// the program's modules. Each import registers the same deferred load; the
// second one finds it registered and waits with it. This run never calls
// the island module, so Node never starts and libnode is never mapped.
import { existsSync, readFileSync } from "node:fs";
import { installPatch } from "./patch.ts";
import { describePatch } from "./reader.ts";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("start", typeof installPatch, describePatch());
if (process.argv.length > 99) {
  installPatch();
  console.log("patched:", readFileSync("/scriptc/does/not/exist", "utf8"));
}
console.log("libnode mapped:", libnodeMapped());
