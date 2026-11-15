// @requires-libnode
// Module-level constants whose initializers only call into a Node island
// package with literal arguments and each other. The island evaluates such
// initializers itself (a generated island module per constant), and each
// module is deferred like the package's own: the program never uses
// the constants' values, so Node never starts and libnode is never mapped.
// What it reads of them before that (their kind, their identity) comes from
// the build-time interface snapshot.
import { existsSync, readFileSync } from "node:fs";
import { Kit } from "shape-kit";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

const name = Kit.text({ label: "name", max: 40 });
const age = Kit.number({ min: 0 });
export const person = Kit.record({ name, age: age, tags: Kit.list(Kit.text()) });

console.log("start");
console.log(typeof name, typeof age, typeof person);
const alias = person;
console.log("identity", alias === person);
console.log("libnode mapped:", libnodeMapped());
console.log("end");
