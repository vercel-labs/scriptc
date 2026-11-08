// @requires-libnode
// Island-closed constants of primitive types, from a CommonJS island
// package: the build's probe evaluated the initializers and found them
// deterministic, so the snapshot holds their values and the program
// computes with them without starting Node.
import { existsSync, readFileSync } from "node:fs";
import { isNewer, major, tag } from "ver-kit";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

const current: number = major("4.12.1");
const newer: boolean = isNewer("4.12.1", "4.2.0");
const label: string = tag("v", "4.12.1");

console.log(current + 1, newer, label, label.length);
console.log("libnode mapped:", libnodeMapped());
