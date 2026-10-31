// @requires-libnode
// A Node island package that reads its own files when it loads (scope-B
// NI-7e): reads inside its package are guarded inputs, so the load defers
// and the first call sees the same contents.
import { existsSync, readFileSync } from "node:fs";
import { greet } from "data-pkg";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("before first use, libnode mapped:", libnodeMapped());
console.log(greet("native"));
