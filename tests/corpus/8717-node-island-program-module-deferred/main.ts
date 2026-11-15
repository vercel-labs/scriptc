// @requires-libnode
// Two modules of the program that run in a Node island (one patches a
// builtin's CommonJS export, the other reads it through that object) and
// whose top levels only declare. The build proves that statically, so it
// may evaluate them to take their interface snapshot, and their loads wait
// like an island package's: this run never calls them, Node never starts
// and libnode is never mapped.
import { existsSync, readFileSync } from "node:fs";
import { installPatch } from "./patch.ts";
import { readThroughRequire } from "./read.ts";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("start", typeof installPatch, typeof readThroughRequire, installPatch.name);
if (process.argv.length > 99) {
  installPatch();
  console.log("reader:", readThroughRequire());
}
console.log("libnode mapped:", libnodeMapped());
