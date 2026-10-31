// @requires-libnode
// A statically imported Node island package the program never calls. The
// package's evaluation has no effects, so the build defers it (scope-B
// NI-7): Node never starts and libnode is never mapped, and what the
// program reads of the package before that comes from the build-time
// interface snapshot (kinds, function names and lengths, constants).
import { existsSync, readFileSync } from "node:fs";
import { arrow, format, helpers, LIMIT, Shape, VERSION } from "lazy-pkg";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("start");
console.log(typeof format, format.name, format.length);
console.log(typeof Shape, Shape.name, Shape.length);
console.log(VERSION, LIMIT, typeof helpers);
const plain = { kind: "native" };
console.log("instanceof", plain instanceof Shape);
const alias = format;
console.log("identity", alias === format);
console.log("libnode mapped:", libnodeMapped());
// An arrow function has no prototype: instanceof throws, as in Node.
try {
  console.log("instanceof arrow", plain instanceof (arrow as unknown as typeof Shape));
} catch (e) {
  console.log("instanceof arrow throws", (e as Error).name);
}
console.log("end");
