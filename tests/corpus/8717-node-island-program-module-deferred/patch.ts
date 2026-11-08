// Patches the CommonJS fs object's readFileSync when asked to. Its top
// level only declares: a require function, the fs object, a function.
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
