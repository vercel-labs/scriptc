// @requires-libnode
// Island modules that share state and no file, loaded by every run in the
// order the build's probe takes: static imports, a writer before its
// reader, across two modules of the program, one of which imports a module
// the entry already imported. Each recorded load is what this run computes,
// so the program reads the readers' values without Node ever starting.
import { existsSync, readFileSync } from "node:fs";
import globalWriter from "state-kit/global-writer.js";
import globalReader from "state-kit/global-reader.js";
import { loaded, processMode, sharedCount } from "./later.mjs";
import lastReader from "state-kit/last-reader.js";

function libnodeMapped() {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("global:", globalWriter.wrote, globalReader.level);
console.log("process:", processMode);
console.log("another module's private state:", sharedCount);
console.log("each saw the other:", loaded.join(", "));
console.log("written last:", lastReader.last);
console.log("libnode mapped:", libnodeMapped());
