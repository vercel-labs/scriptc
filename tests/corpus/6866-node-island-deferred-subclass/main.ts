// @requires-libnode
// A native class extending a deferred island class at top level (scope-B
// NI-5d) is created on first use: a program that never constructs it
// reads its name, typeof and instanceof against native values without
// starting Node, and libnode is never mapped.
import { existsSync, readFileSync } from "node:fs";
import { KitError } from "errkit";

class BuildError extends KitError {
  hint = "retry";
  constructor(message: string) {
    super({ code: "BUILD", message });
  }
}

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

function fail(really: boolean): void {
  if (really) throw new BuildError("never");
}

console.log("start");
console.log(typeof BuildError, BuildError.name, typeof KitError, KitError.name);
const plain = { message: "native" };
console.log("instanceof", plain instanceof BuildError, plain instanceof KitError);
fail(false);
console.log("libnode mapped:", libnodeMapped());
console.log("end");
