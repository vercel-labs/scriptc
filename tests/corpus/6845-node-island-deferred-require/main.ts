// @requires-libnode
// A native package's top-level require() of a Node island package is
// deferred like a static import (scope-B NI-7d): the island's load (which
// sets and clears a timer, leaving nothing behind) waits for the first
// call, and Node does not start at boot.
import { existsSync, readFileSync } from "node:fs";
import { calls, quadruple } from "native-wrapper";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("before first use, libnode mapped:", libnodeMapped());
console.log("quadruple", quadruple(3), quadruple(5));
console.log("calls", calls());
