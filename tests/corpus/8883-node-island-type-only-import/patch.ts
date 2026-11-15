// Patches the CommonJS fs object's readFileSync for the rest of the process
// (pi's photon.ts shape).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched payload") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
