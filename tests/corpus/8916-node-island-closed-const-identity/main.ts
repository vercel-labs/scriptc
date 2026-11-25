// @requires-libnode
// One island-closed constant seen through two importers, each of which
// builds its own constant over it: both hold the same island object, before
// Node starts (the snapshot's stubs) and after.
import { existsSync, readFileSync } from "node:fs";
import { fromLeft, sameInLeft } from "./left.ts";
import { fromRight, sameInRight } from "./right.ts";
import { shared } from "./shapes.ts";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("stubs", sameInLeft(shared), sameInRight(shared), fromLeft === fromRight);
console.log("libnode mapped:", libnodeMapped());
console.log("values", fromLeft.item === shared, fromRight.item === shared);
console.log("after", sameInLeft(fromRight.item), fromLeft.item === fromRight.item);
